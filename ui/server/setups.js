import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { discover, readSkill, publicItem, hash, fail } from './setup-discovery.js'

export const usableSetup = (setup) => ({ ...setup, items: setup.items.filter(i => !i.disabled && !i.issues.length && (i.kind === 'skill' || i.config)) })
export const SETUP_ID = /^[a-f0-9]{24}$/
const TTL = 15 * 60_000
export const MAX_SELECTION = 64 * 1024 * 1024
// Tokens pin the reviewed snapshot. The browser cannot submit arbitrary paths,
// executable configuration or replacement skill contents to the save endpoint.
export function createSetupStore({ home = os.homedir(), dir = path.resolve(import.meta.dirname, '../.state/setups'), now = Date.now, maxSelection = MAX_SELECTION, state = { scans: new Map(), previews: new Map(), edits: Promise.resolve() } } = {}) {
  const { scans, previews } = state
  const expire = (map) => { for (const [key, value] of map) if (value.expires < now()) map.delete(key); if (map.size >= 20) throw fail('Too many pending imports. Finish one or wait 15 minutes.', 429) }
  const token = (map, id) => { const value = map.get(id); if (!value || value.expires < now()) throw fail('This preview expired. Scan and review again.', 409); return value }
  const filename = (id) => { if (!SETUP_ID.test(id)) throw fail('Setup not found.', 404); return path.join(dir, id + '.json') }
  async function get(id) { try { const setup = JSON.parse(await fs.readFile(filename(id), 'utf8')); if (hash(JSON.stringify(setup.items)) !== setup.revision) throw fail('Setup integrity check failed.', 409); return setup } catch (e) { if (e.code === 'ENOENT') throw fail('Setup not found.', 404); if (e instanceof SyntaxError) throw fail('Saved Setup is invalid. Restore it or import a new snapshot.', 409); throw e } }
  const view = (s) => ({ ...s, items: s.items.map(publicItem) })
  return {
    get,
    preview(id) { return token(previews, id) },
    removeReviewItem(previewToken, itemId) {
      const preview = token(previews, previewToken)
      if (!preview.items.some(item => item.id === itemId)) throw fail('Import item not found.', 404)
      const items = preview.items.filter(item => item.id !== itemId)
      const credentials = Object.fromEntries(Object.entries(preview.credentials || {}).filter(([id]) => id !== itemId))
      const review = this.stage(items, credentials)
      previews.delete(previewToken)
      return review
    },
    stage(items, credentials = {}) {
      expire(previews)
      const id = randomUUID(), revision = hash(JSON.stringify(items))
      previews.set(id, { items, credentials, revision, expires: now() + TTL })
      return { token: id, revision, items: items.map(publicItem) }
    },
    delete(id, revision, beforeDelete = async () => {}) {
      const edit = state.edits.then(async () => {
        const setup = await get(id)
        if (revision !== setup.revision) throw fail('This Setup changed. Refresh the list before deleting it.', 409)
        // Keep the setup retryable if policy cleanup or coverage validation fails.
        await beforeDelete(setup)
        await fs.unlink(filename(id))
        return { deleted: id }
      })
      state.edits = edit.catch(() => {})
      return edit
    },
    deleteItem(id, itemId, revision, beforeWrite = async () => {}) {
      const edit = state.edits.then(async () => {
        const setup = await get(id)
        if (revision !== setup.revision) throw fail('This Setup changed. Close and reopen it before deleting a row.', 409)
        if (!setup.items.some((item) => item.id === itemId)) throw fail('Setup item not found.', 404)
        const items = setup.items.filter((item) => item.id !== itemId)
        const updated = { ...setup, items, revision: hash(JSON.stringify(items)) }
        const temporary = filename(id) + '.' + randomUUID() + '.tmp'
        try {
          await fs.writeFile(temporary, JSON.stringify(updated), { flag: 'wx', mode: 0o600 })
          await beforeWrite(updated)
          await fs.rename(temporary, filename(id))
        } finally { await fs.rm(temporary, { force: true }) }
        return view(updated)
      })
      state.edits = edit.catch(() => {})
      return edit
    },
    async list() { const files = await fs.readdir(dir).catch((e) => { if (e.code === 'ENOENT') return []; throw e }); return Promise.all(files.filter((n) => /^[a-f0-9]{24}\.json$/.test(n)).map(async (n) => view(await get(n.slice(0, -5))))) },
    async scan(sources) { expire(scans); const result = await discover({ sources, home }); const id = randomUUID(); scans.set(id, { ...result, expires: now() + TTL }); return { token: id, items: result.items.map(publicItem), warnings: result.warnings } },
    async review(scanToken, ids) {
      const scan = token(scans, scanToken)
      if (!Array.isArray(ids) || !ids.length || ids.length > scan.items.length || new Set(ids).size !== ids.length) throw fail('Select one or more unique discovered items.')
      const selected = ids.map((id) => { const item = scan.items.find((i) => i.id === id); if (!item) throw fail('Unknown discovery item.'); return item })
      const items = [], credentials = {}
      let selectionBytes = 2
      for (const selectedItem of selected) {
        const { root, _sourceCredentials, ...item } = selectedItem
        if (_sourceCredentials) { credentials[item.id] = _sourceCredentials; item.sourceCredentialFields = Object.keys(_sourceCredentials) }
        if (item.kind === 'skill') {
          try { Object.assign(item, await readSkill(root, home)) } catch (e) { item.issues = [e.status ? e.message : 'Skill could not be read safely.']; item.files = [] }
        }
        selectionBytes += Buffer.byteLength(JSON.stringify(item)) + (items.length ? 1 : 0)
        if (selectionBytes > maxSelection) throw fail(`This selection exceeds ${maxSelection / 1024 / 1024} MB. Select fewer skills and import the rest as a second setup.`)
        items.push(item)
      }
      expire(previews); const id = randomUUID(); const revision = hash(JSON.stringify(items))
      previews.set(id, { items, credentials, revision, expires: now() + TTL })
      return { token: id, revision, items: items.map(publicItem) }
    },
    async file(previewToken, itemId, filename) {
      const preview = token(previews, previewToken)
      const f = preview.items.find((i) => i.id === itemId)?.files?.find((f) => f.path === filename)
      if (!f) throw fail('Preview file not found.', 404)
      return f.encoding === 'base64' ? { content: 'ZIP archive · copied as-is, not extracted or executed.\n\n' + (f.archiveEntries || []).map(entry => `${entry.path} · ${entry.bytes} B`).join('\n') } : { content: f.content }
    },
    buildSnapshot(source, items) {
      const edit = state.edits.then(async () => {
      const current = await get(source.id)
      if (current.revision !== source.revision) throw fail('Setup changed during preparation. Review it and retry.', 409)
      const id = hash('quick-setup:' + source.id + ':' + source.revision).slice(0, 24)
      const setup = { id, name: source.name.slice(0, 65) + ' (prepared)', revision: hash(JSON.stringify(items)), createdAt: new Date(now()).toISOString(), owner: 'local operator', preparedFrom: { id: source.id, revision: source.revision }, items }
      await fs.mkdir(dir, { recursive: true, mode: 0o700 })
      try { await fs.writeFile(filename(id), JSON.stringify(setup), { flag: 'wx', mode: 0o600 }) }
      catch (e) { if (e.code !== 'EEXIST') throw e }
      return view(await get(id))
      })
      state.edits = edit.catch(() => {})
      return edit
    },
    async save(previewToken, name, acknowledged) {
      if (acknowledged !== true) throw fail('Review the selected files and acknowledge the import.')
      if (typeof name !== 'string' || !name.trim() || name.length > 80 || /[\x00-\x1f]/.test(name)) throw fail('Enter a Setup name, up to 80 characters.')
      const preview = token(previews, previewToken)
      const setup = { id: randomUUID().replaceAll('-', '').slice(0, 24), name: name.trim(), revision: preview.revision, createdAt: new Date(now()).toISOString(), owner: 'local operator', items: preview.items }
      await fs.mkdir(dir, { recursive: true, mode: 0o700 })
      await fs.writeFile(filename(setup.id), JSON.stringify(setup), { flag: 'wx', mode: 0o600 })
      previews.delete(previewToken)
      return view(setup)
    },
  }
}
// Keep import tokens and the edit queue across reloads, but always recreate methods.
const stateKey = Symbol.for('openshell.console.setup-store-state.v1')
const state = globalThis[stateKey] ??= { scans: new Map(), previews: new Map(), edits: Promise.resolve() }
export const setupStore = createSetupStore({ state })
export async function resolveSetups(ids = []) {
  if (!Array.isArray(ids) || ids.length > 8 || new Set(ids).size !== ids.length) throw fail('Choose up to eight unique Setups.')
  return Promise.all(ids.map((id) => setupStore.get(id)))
}
// Each saved Setup keeps one managed egress policy in step with its items.
// A policy problem is reported, never undoes the Setup change.
async function syncEgress(id) {
  try { const { syncSetupPolicy } = await import('./setup-egress.js'); return { egressPolicy: await syncSetupPolicy(await setupStore.get(id)) } }
  catch (e) { return { egressPolicy: null, egressPolicyError: e.status ? e.message : 'The policy file could not be written.' } }
}
export async function setupRoute(method, parts, input) {
  if (parts[0] !== 'setups') return undefined
  if (method === 'GET' && parts.length === 3 && parts[1] === 'preparations') return (await import('./setup-preparation.js')).preparationStatus(parts[2])
  if (method === 'POST' && parts.length === 4 && parts[1] === 'preparations' && parts[3] === 'cancel') return (await import('./setup-preparation.js')).cancelPreparation(parts[2])
  if (method === 'POST' && parts.length === 3 && parts[2] === 'prepare-launch') return (await import('./setup-preparation.js')).prepareLaunch(setupStore, parts[1], input)
  if (method === 'GET' && parts.length === 1) return setupStore.list()
  if (method === 'POST' && parts.length === 3 && parts[2] === 'prepare') return setupStore.stage((await setupStore.get(parts[1])).items)
  if (method === 'POST' && parts.length === 3 && parts[2] === 'delete') {
    return setupStore.delete(parts[1], input.revision, async () => {
      await (await import('./setup-egress.js')).removeSetupPolicy(parts[1])
    })
  }
  if (method === 'POST' && parts.length === 3 && parts[2] === 'delete-item') {
    return setupStore.deleteItem(parts[1], input.item, input.revision, async (updated) => {
      await (await import('./setup-egress.js')).syncSetupPolicy(updated)
    })
  }
  if (method !== 'POST' || parts.length !== 2) return undefined
  if (parts[1] === 'prepare') return (await import('./setup-preparation.js')).prepareImport(setupStore, input)
  if (parts[1] === 'scan') return setupStore.scan(input.sources)
  if (parts[1] === 'review') return setupStore.review(input.token, input.ids)
  if (parts[1] === 'remove-review-item') return setupStore.removeReviewItem(input.token, input.item)
  if (parts[1] === 'file') return setupStore.file(input.token, input.item, input.path)
  if (parts[1] === 'save') { const view = await setupStore.save(input.token, input.name, input.acknowledged); return { ...view, ...(await syncEgress(view.id)) } }
  return undefined
}
