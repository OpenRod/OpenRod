import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

// Gateway endpoint + immutable sandbox id → the MCPs & Skills setups it uses.
// Names can be reused, including on another gateway, and cannot identify grants.
// A Quick-setup snapshot also records the setup it was prepared from.
const FILE = path.resolve(import.meta.dirname, '../.state/setup-members.json')
const NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
const ID = /^[a-f0-9]{24}$/
const fail = (message, status = 400) => Object.assign(new Error(message), { status })
const ids = (input) => [...new Set((Array.isArray(input) ? input : []).map(String).filter((id) => ID.test(id)))]
const identityPart = (value, limit) => typeof value === 'string' && value.length > 0 && value.length <= limit && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value)
const keyFor = (gateway, id) => identityPart(gateway, 2048) && identityPart(id, 256) ? JSON.stringify([gateway, id]) : null
const storedKey = (key) => {
  try { const parts = JSON.parse(key); return Array.isArray(parts) && parts.length === 2 && keyFor(...parts) === key } catch { return false }
}

// Missing ids and pre-identity name-only records are deliberately ignored.
// Re-enabling a setup records its current identity; guessing a migration could
// grant access to a replacement sandbox that never selected that setup.
export function sandboxSetups(members, sandbox, endpoint) {
  const key = keyFor(endpoint, sandbox?.id)
  return key ? ids(members[key]) : []
}

export function createSetupMembers(file = FILE) {
  let edits = Promise.resolve()
  async function read() {
    let raw
    try { raw = JSON.parse(await fs.readFile(file, 'utf8')) } catch (e) { if (e.code === 'ENOENT' || e instanceof SyntaxError) return {}; throw e }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    return Object.fromEntries(Object.entries(raw).filter(([key]) => storedKey(key)).map(([key, list]) => [key, ids(list)]).filter(([, list]) => list.length))
  }
  // Read-modify-write, one at a time; the file is replaced atomically.
  const edit = (identity, change, { strict = true } = {}) => {
    const run = edits.then(async () => {
      const key = keyFor(identity?.gateway, identity?.id)
      if (!NAME.test(String(identity?.name ?? '')) || !key) { if (strict) throw fail('Choose a sandbox identity with its gateway, id and name.'); return [] }
      const all = await read()
      const next = ids(change(all[key] ?? []))
      if (JSON.stringify(next) === JSON.stringify(all[key] ?? [])) return next
      if (next.length) all[key] = next
      else delete all[key]
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
      const temporary = `${file}.${randomUUID()}.tmp`
      try {
        await fs.writeFile(temporary, `${JSON.stringify(Object.fromEntries(Object.entries(all).sort(([a], [b]) => a.localeCompare(b))), null, 2)}\n`, { flag: 'wx', mode: 0o600 })
        await fs.rename(temporary, file)
      } finally { await fs.rm(temporary, { force: true }) }
      return next
    })
    edits = run.catch(() => {})
    return run
  }
  return {
    readSetupMembers: read,
    setSandboxSetups: (identity, list) => edit(identity, () => ids(list)),
    addSandboxSetups: (identity, list) => edit(identity, (current) => [...current, ...ids(list)]),
    removeSandboxSetups: (identity, list) => edit(identity, (current) => current.filter((id) => !ids(list).includes(id))),
    forgetSandbox: (identity) => edit(identity, () => [], { strict: false }),
  }
}

export const { readSetupMembers, setSandboxSetups, addSandboxSetups, removeSandboxSetups, forgetSandbox } = createSetupMembers()
