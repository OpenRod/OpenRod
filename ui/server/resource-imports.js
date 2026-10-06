import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { contextKey, contextSelection, runWithContext, resolveGateway } from './gateway.js'
import { scopedStateDirectory } from './paths.js'
import { listGroups, orgRoute, readOrg } from './org.js'
import { listPolicies } from './egress.js'
import { findTemplate, listTemplates, validateTemplate, policyRoute } from './policy.js'
import { composeTemplate } from '../shared/policy-templates.js'
import { getSetupStore } from './setups.js'
import { listImageTemplates, imageTemplateRoute } from './image-templates.js'
import { IMPORT_TYPES, IMPORT_BODY_LIMIT, fingerprint, importFail, portableResource, validateImportBundle, validImportId } from './resource-import-portable.js'

export { IMPORT_BODY_LIMIT } from './resource-import-portable.js'
export const importCapabilities = ({ activity = false } = {}) => ({
  version: 1,
  types: {
    policyTemplates: { supported: true, internal: true, description: 'Materialized base security policies included as group dependencies.' },
    groups: { supported: true, description: 'Group definitions; sandbox memberships are not copied.' },
    network: { supported: true, description: 'Group/setup rules with remapped targets. Global and sandbox-specific rules need manual review.' },
    setups: { supported: true, description: 'Saved MCP definitions and text skill files. Packages must be prepared and credentials reconnected.' },
    templates: { supported: true, description: 'Image references or recipes rebuilt on the destination. Environment values are excluded.' },
    sandboxes: { supported: false, reason: 'Use Copy workspace on a running sandbox. Configuration import does not move workspace files.' },
    secrets: { supported: false, reason: 'Reconnect or add credentials on the destination. Secret values are never exported in configuration bundles.' },
    activity: activity ? { supported: true, description: 'Normalized historical events, up to 500 per reviewed batch, preserving original timestamps and source identity.' } : { supported: false, reason: 'The activity store is unavailable at this location.' },
  },
  limits: { bytes: IMPORT_BODY_LIMIT, resources: 500, activityEvents: 500, activeJobs: 2 }, conflicts: ['create', 'reuse'],
})
const running = globalThis[Symbol.for('openrod.resource-import.running.v1')] ??= new Map()
const queues = globalThis[Symbol.for('openrod.resource-import.queues.v1')] ??= new Map()
const phases = { policyTemplates: -1, groups: 0, setups: 1, network: 2, templates: 3, activity: 4 }
const terminal = new Set(['completed', 'partial', 'failed', 'cancelled', 'interrupted'])
const JOB_ID = /^[a-f0-9]{32}$/
const now = () => new Date().toISOString()

function queue(key, task) {
  const result = (queues.get(key) || Promise.resolve()).then(task, task)
  const settled = result.catch(() => {})
  queues.set(key, settled)
  settled.finally(() => { if (queues.get(key) === settled) queues.delete(key) })
  return result
}
async function atomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${randomUUID()}.tmp`
  try { await fs.writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); await fs.rename(temporary, file) }
  finally { await fs.rm(temporary, { force: true }) }
}
function jobView(job) {
  return {
    id: job.id, status: job.status, source: job.source, destination: job.destination, createdAt: job.createdAt, updatedAt: job.updatedAt,
    warnings: job.warnings, cancelRequested: Boolean(job.cancelRequested),
    items: job.items.map(({ data, reuseRevision, attempted, ...item }) => item),
    counts: { total: job.items.length, completed: job.items.filter(item => ['created', 'reused'].includes(item.status)).length, failed: job.items.filter(item => ['failed', 'blocked'].includes(item.status)).length, pending: job.items.filter(item => ['pending', 'running'].includes(item.status)).length },
  }
}
function translated(resource, mapping, targetId) {
  const data = structuredClone(resource.data)
  if (resource.type === 'templates') { data.name = targetId; data.recipe.name = targetId; data.recipe.setups = data.recipe.setups.map(id => mapping[`setups:${id}`]); data.recipe.setupRevisions = {} }
  else {
    data.id = targetId
    if (resource.type === 'groups' && data.template) data.template = mapping[`policyTemplates:${data.template}`]
    if (resource.type === 'network') {
      data.appliesTo.groups = data.appliesTo.groups.map(id => mapping[`groups:${id}`])
      data.appliesTo.setups = data.appliesTo.setups.map(id => mapping[`setups:${id}`])
      if (data.setup) data.setup.id = mapping[`setups:${data.setup.id}`]
    }
  }
  return data
}
function comparable(type, value) {
  const { data } = portableResource(type, value)
  // Destination preparation is independent from identity mapping; source ids and
  // template revision pins are not content differences.
  if (type === 'templates') data.recipe.setupRevisions = {}
  return fingerprint(data)
}

function defaultAdapter({ activityStore } = {}) {
  return {
    async list(type) {
      if (type === 'policyTemplates') return listTemplates()
      if (type === 'activity') return activityStore ? activityStore.coverage().sources.filter(source => source.importBatch).map(source => ({ ...source, importReceipt: true })) : []
      if (type === 'groups') return listGroups()
      if (type === 'network') return listPolicies()
      if (type === 'templates') return listImageTemplates()
      const store = getSetupStore()
      return Promise.all((await store.list()).map(setup => store.get(setup.id)))
    },
    async organizationRules(context) {
      const [organization, groups] = await Promise.all([readOrg(), listGroups()])
      const rules = []
      for (const group of groups) for (let offset = 0; offset < organization.blocked.length; offset += 200) rules.push({
        id: 'org-block-' + fingerprint([context, group.id, offset]).slice(0, 28), name: `Source restrictions: ${group.name}`.slice(0, 80), action: 'block',
        destinations: organization.blocked.slice(offset, offset + 200), appliesTo: { everyone: false, groups: [group.id], sandboxes: [], setups: [] }, sourceOrganizationBlock: true,
      })
      return rules
    },
    async export(type, input, context) {
      if (type === 'policyTemplates') {
        const catalog = await listTemplates()
        for (const group of await listGroups()) if (group.template && !catalog.some(policy => policy.id === group.template)) {
          const policy = await findTemplate(group.template)
          if (policy) catalog.push(policy)
        }
        return catalog.map(policy => validateTemplate({ ...composeTemplate(policy, [], catalog), accessTemplates: [] }))
      }
      if (type !== 'activity') return this.list(type)
      if (!activityStore) throw importFail('The activity store is unavailable.', 503)
      const query = input.activity || {}
      const page = activityStore.query({ range: query.from || query.to ? 'custom' : 'all', ...(query.from ? { from: query.from } : {}), ...(query.to ? { to: query.to } : {}), ...(query.snapshot != null ? { snapshot: query.snapshot } : {}), offset: query.offset || 0, limit: 500 })
      if (!page.events.length) return []
      const id = 'history-' + fingerprint([context, page.snapshot, query.offset || 0, query.from, query.to]).slice(0, 24)
      return [{ id, name: `Activity (${page.events.length} events)`, origin: context, events: page.events, exportPage: { snapshot: page.snapshot, offset: query.offset || 0, total: page.total, exported: page.events.length, nextOffset: page.nextOffset } }]
    },
    async prepare(type, data, job, item) {
      if (type !== 'templates' || !data.recipe.setups.length) return data
      const { prepareLaunch, preparationStatus, cancelPreparation } = await import('./setup-preparation.js')
      const store = getSetupStore(), setups = []
      for (const id of data.recipe.setups) {
        const source = await store.get(id)
        let result = await prepareLaunch(store, id, { revision: source.revision })
        const preparationId = result.id, deadline = Date.now() + 25 * 60_000
        while (result.status === 'running' && Date.now() < deadline) {
          if (job.cancelRequested) { await cancelPreparation(preparationId); throw importFail('Setup preparation cancelled.', 409) }
          await new Promise(resolve => setTimeout(resolve, 1500))
          result = await preparationStatus(preparationId)
        }
        if (result.status !== 'complete' || !result.setup) throw importFail('A required MCP package could not be prepared. Open the imported setup and retry preparation.', 409)
        const ready = await store.get(result.setup.id)
        if (ready.items.some(item => !item.disabled && item.issues.length)) throw importFail('A required setup needs credentials or configuration. Resolve its warnings on the destination before importing this template.', 409)
        setups.push(ready.id)
        if (ready.id !== id) item.warnings = [...new Set([...item.warnings, `Prepared setup snapshot ${ready.id} is used by this template; source setup ${id} remains available.`])]
      }
      return { ...data, recipe: { ...data.recipe, setups, setupRevisions: {} } }
    },
    async create(type, data, job, item) {
      if (type === 'policyTemplates') return policyRoute('POST', ['templates'], { ...data, isNew: true })
      if (type === 'activity') {
        if (!activityStore) throw importFail('The activity store is unavailable.', 503)
        const scope = `import:${fingerprint(data.origin)}`
        for (const event of data.events) {
          if (job.cancelRequested) throw importFail('Activity import cancelled. Already imported events are retained and retry will deduplicate them.', 409)
          activityStore.ingest({ ...event, importedFrom: { ...data.origin, eventId: event.id, receivedAt: event.receivedAt || null }, importedAt: now(), importJob: job.id, location: { label: `${data.origin.gateway} / ${data.origin.workspace} (imported)` } }, scope)
        }
        activityStore.source(data.id, { importBatch: true, name: data.name, revision: fingerprint(data), eventCount: data.events.length, origin: data.origin, completedAt: now() })
        return
      }
      if (type === 'groups') return orgRoute('POST', ['org', 'groups'], { ...data, isNew: true })
      if (type === 'network') return orgRoute('POST', ['egress', 'policies'], { ...data, isNew: true })
      if (type === 'templates') {
        await imageTemplateRoute('POST', ['image-templates'], { recipe: data.recipe })
        const deadline = Date.now() + 25 * 60_000
        while (Date.now() < deadline) {
          const template = (await listImageTemplates()).find(template => template.name === data.name)
          if (template?.status === 'ready') return template
          if (template?.status === 'failed') throw importFail('Template build failed. Open the destination template to inspect its build log.', 502)
          if (job.cancelRequested) {
            await imageTemplateRoute('POST', ['image-templates', data.name, 'cancel'], {})
            throw importFail('Template build cancelled.', 409)
          }
          await new Promise(resolve => setTimeout(resolve, 1500))
        }
        throw importFail('Template build timed out. Inspect the destination template before retrying.', 504)
      }
      const items = data.items
      const setup = { ...data, revision: fingerprintItems(items), createdAt: now(), owner: 'local operator', importSource: { job: job.id, key: item.key }, items }
      const dir = path.join(scopedStateDirectory(), 'setups')
      await fs.mkdir(dir, { recursive: true, mode: 0o700 })
      const final = path.join(dir, `${data.id}.json`), temporary = `${final}.${randomUUID()}.tmp`
      try {
        await fs.writeFile(temporary, JSON.stringify(setup), { flag: 'wx', mode: 0o600 })
        await fs.link(temporary, final) // Atomic, exclusive publication; a crash cannot leave a partial Setup.
      } finally { await fs.rm(temporary, { force: true }) }
      return setup
    },
    async reset(type, id) {
      if (type !== 'templates') return
      const template = (await listImageTemplates()).find(template => template.name === id)
      if (template?.status === 'failed' && !template.exists) await imageTemplateRoute('POST', ['image-templates', id, 'dismiss'], {})
    },
  }
}
// Setup storage hashes its exact JSON array rather than a sorted-key canonical form.
import { hash as fingerprintItemsRaw } from './setup-discovery.js'
const fingerprintItems = items => fingerprintItemsRaw(JSON.stringify(items))

export function createResourceImports({ directory = path.join(scopedStateDirectory(), 'resource-imports'), context = contextSelection(), adapter, activityStore, sourceKind, onEvent = async () => {} } = {}) {
  adapter ??= defaultAdapter({ activityStore })
  const destination = { gateway: context.gateway || '', workspace: context.workspace || '' }
  const file = id => { if (!JOB_ID.test(id || '')) throw importFail('Import not found.', 404); return path.join(directory, `${id}.json`) }
  const key = id => file(id)
  const save = async job => { job.updatedAt = now(); await atomic(file(job.id), job) }
  const read = async id => {
    let job
    try { job = JSON.parse(await fs.readFile(file(id), 'utf8')) } catch (error) { if (error.code === 'ENOENT') throw importFail('Import not found.', 404); throw error }
    if (contextKey(job.destination) !== contextKey(destination)) throw importFail('Import belongs to another destination.', 403)
    if (job.status === 'running' && !running.has(key(id))) {
      job.status = 'interrupted'
      for (const item of job.items) if (item.status === 'running') { item.status = 'failed'; item.error = 'The process stopped during this item. Retry to check the destination and resume.' }
    }
    return job
  }
  const inventory = async type => adapter.list(type)
  const find = async (type, id) => (await inventory(type)).find(value => (value.id ?? value.name) === id)
  const equal = (type, existing, data) => { if (type === 'activity' && existing.importReceipt) return existing.revision === fingerprint(data); try { return comparable(type, existing) === comparable(type, data) } catch { return false } }
  const emit = async (job, action) => { try { await onEvent({ action, job: jobView(job) }) } catch { /* Activity delivery must not undo an import. */ } }

  async function run(job) {
    try {
      for (const item of job.items) {
        if (['created', 'reused'].includes(item.status)) continue
        if (job.cancelRequested) break
        const failedDependency = item.dependencies.find(dependency => !job.items.some(other => other.key === dependency && ['created', 'reused'].includes(other.status)))
        if (failedDependency) { item.status = 'blocked'; item.error = 'A dependency did not complete. Retry after resolving the failed item.'; await save(job); continue }
        item.status = 'running'; item.error = null; await save(job)
        try {
          let existing = await find(item.type, item.targetId)
          if (item.action === 'reuse') {
            if (!existing || (item.type === 'activity' && existing.importReceipt ? existing.revision : comparable(item.type, existing)) !== item.reuseRevision) throw importFail('The destination resource changed after review. Create a new plan.', 409)
            item.status = 'reused'
          } else if (existing && item.attempted && equal(item.type, existing, item.data) && (!existing.status || existing.status === 'ready')) {
            item.status = 'created'
            item.warnings = [...new Set([...item.warnings, 'Recovered an already-created resource from the interrupted attempt.'])]
          } else {
            if (existing && item.attempted && existing.status === 'failed' && !existing.exists) { await adapter.reset?.(item.type, item.targetId); existing = await find(item.type, item.targetId) }
            if (existing) throw importFail('The destination identity is already in use or a build is still running. Review it before retrying or create a new plan.', 409)
            await adapter.validate?.(item.type, item.data)
            if (adapter.prepare) item.data = await adapter.prepare(item.type, item.data, job, item)
            if (job.cancelRequested) throw importFail('Import cancelled before creating this resource.', 409)
            item.attempted = true; await save(job)
            await adapter.create(item.type, item.data, job, item)
            const created = await find(item.type, item.targetId)
            if (!created || !equal(item.type, created, item.data) || (created.status && created.status !== 'ready')) throw importFail('Destination verification did not complete. Inspect the resource before retrying.', 502)
            item.status = 'created'
          }
        } catch (error) {
          item.status = job.cancelRequested ? 'cancelled' : 'failed'; item.error = error.status ? error.message : 'Import failed. Check destination connectivity and retry.'
        }
        await save(job)
      }
      const completed = job.items.filter(item => ['created', 'reused'].includes(item.status)).length
      job.status = job.cancelRequested ? 'cancelled' : completed === job.items.length ? 'completed' : completed ? 'partial' : 'failed'
      if (job.cancelRequested) for (const item of job.items) if (item.status === 'pending') item.status = 'cancelled'
      await save(job); await emit(job, 'import.' + job.status)
    } catch {
      job.status = 'failed'
      job.warnings = [...new Set([...job.warnings, 'Import stopped unexpectedly. Check destination storage and retry.'])]
      await save(job).catch(() => {})
    } finally { running.delete(key(job.id)) }
  }

  const service = {
    capabilities: () => importCapabilities({ activity: Boolean(activityStore) }),
    async export(input = {}) {
      const types = input.types || IMPORT_TYPES.filter(type => !['activity', 'policyTemplates'].includes(type))
      if (!Array.isArray(types) || types.some(type => !IMPORT_TYPES.includes(type))) throw importFail('Choose supported resource types.')
      const resources = [], excluded = []
      const needed = new Set(types)
      if (needed.has('templates')) needed.add('setups')
      if (needed.has('network')) { needed.add('groups'); needed.add('setups') }
      if (needed.has('groups')) needed.add('policyTemplates')
      const pages = {}
      for (const type of IMPORT_TYPES) {
        if (!needed.has(type)) continue
        try {
          for (const raw of await (adapter.export ? adapter.export(type, input, destination) : inventory(type))) {
            try {
              const resource = portableResource(type, raw)
              if (raw.exportPage) { pages[type] = raw.exportPage; if (raw.exportPage.nextOffset != null) resource.warnings.push(`This batch includes ${raw.exportPage.exported} of ${raw.exportPage.total} matching events. Export the next page to copy older history.`) }
              resources.push(resource)
            }
            catch (error) { excluded.push({ type, id: raw.id ?? raw.name, name: raw.name, reason: error.status ? error.message : 'This resource could not be exported.' }) }
          }
        } catch { excluded.push({ type, reason: 'Could not read this resource type. Check source connectivity.' }) }
      }
      if (needed.has('groups') && adapter.organizationRules) {
        for (const rule of await adapter.organizationRules(destination)) {
          const resource = portableResource('network', rule)
          if (!resources.some(other => other.key === resource.key)) {
            resource.warnings.push('Source organization blocks are preserved for this imported group. Destination organization settings stay unchanged.')
            resources.push(resource)
          } else throw importFail('A source rule conflicts with a generated organization restriction. Rename the source rule and export again.', 409)
        }
      }
      const selected = new Set(input.selection || resources.filter(resource => types.includes(resource.type)).map(resource => resource.key))
      for (let previous = -1; previous !== selected.size;) {
        previous = selected.size
        for (const resource of resources) {
          if (resource.requiredForGroups?.some(id => selected.has(`groups:${id}`))) selected.add(resource.key)
          if (selected.has(resource.key)) for (const dependency of resource.dependencies) selected.add(dependency)
        }
      }
      let remote = false
      try { remote = resolveGateway(context.gateway).remote } catch { /* Tests can supply an isolated context. */ }
      const bundle = { version: 1, source: { kind: sourceKind || (remote ? 'host' : 'local'), label: `${destination.gateway || 'Local'} / ${destination.workspace || 'default'}`, context: destination }, resources: resources.filter(resource => selected.has(resource.key)), excluded, ...(Object.keys(pages).length ? { pages } : {}) }
      if (Buffer.byteLength(JSON.stringify(bundle)) > IMPORT_BODY_LIMIT) throw importFail('Configuration export exceeds 8 MiB. Select fewer resources.', 413)
      return bundle
    },
    async plan(input) {
      const bundle = validateImportBundle(input?.bundle)
      const selected = new Set(input.selection || bundle.resources.map(resource => resource.key))
      if (!selected.size || selected.size > 500 || [...selected].some(key => !bundle.resources.some(resource => resource.key === key))) throw importFail('Choose available resources to import.')
      for (let previous = -1; previous !== selected.size;) {
        previous = selected.size
        for (const resource of bundle.resources) {
          if (resource.requiredForGroups?.some(id => selected.has(`groups:${id}`))) selected.add(resource.key)
          if (!selected.has(resource.key)) continue
          for (const dependency of resource.dependencies) {
          if (!bundle.resources.some(resource => resource.key === dependency)) throw importFail(`Missing dependency ${dependency}. Export it with the selected resources.`, 409)
          selected.add(dependency)
          }
        }
      }
      const resources = bundle.resources.filter(resource => selected.has(resource.key)).sort((a, b) => phases[a.type] - phases[b.type] || a.key.localeCompare(b.key))
      const id = randomUUID().replaceAll('-', ''), mapping = {}, items = [], inventories = {}
      for (const type of new Set(resources.map(resource => resource.type))) inventories[type] = await inventory(type)
      for (const resource of resources) {
        const choice = input.conflicts?.[resource.key]
        if (choice && !['create', 'reuse'].includes(choice.action)) throw importFail('Unsupported conflict resolution.')
        const reuse = resource.type === 'activity' && inventories.activity.some(value => (value.id ?? value.name) === resource.id) || choice?.action === 'reuse'
        const existingIds = new Set(inventories[resource.type].map(value => value.id ?? value.name))
        let targetId = resource.id
        if (reuse) targetId = choice?.targetId || resource.id
        else if (resource.type === 'activity') targetId = resource.id
        else if (resource.type === 'setups') targetId = fingerprint([id, resource.key]).slice(0, 24)
        else if (resource.type === 'policyTemplates') targetId = 'import-' + fingerprint([id, resource.key]).slice(0, 32)
        else if (existingIds.has(targetId) || items.some(item => item.type === resource.type && item.targetId === targetId)) {
          const max = { groups: 48, network: 40, templates: 19 }[resource.type]
          targetId = resource.id.slice(0, max - 9).replace(/-+$/, '') + '-' + fingerprint([id, resource.key]).slice(0, 8)
        }
        if (!validImportId(resource.type, targetId)) throw importFail('Invalid destination resource identity.')
        mapping[resource.key] = targetId
        const data = translated(resource, mapping, targetId)
        await adapter.validate?.(resource.type, data)
        const warnings = [...resource.warnings]
        if (targetId !== resource.id && resource.type !== 'setups') warnings.push(`Destination identity: ${targetId}. The existing resource will stay unchanged.`)
        let reuseRevision
        if (reuse) {
          const existing = inventories[resource.type].find(value => (value.id ?? value.name) === targetId)
          if (!existing || !equal(resource.type, existing, data)) throw importFail(`The destination ${resource.name} is not identical to the selected configuration. Create a copy instead.`, 409)
          reuseRevision = resource.type === 'activity' && existing.importReceipt ? existing.revision : comparable(resource.type, existing)
        }
        items.push({ key: resource.key, type: resource.type, name: resource.name, sourceId: resource.id, targetId, action: reuse ? 'reuse' : 'create', status: 'pending', dependencies: resource.dependencies, warnings, error: null, data, ...(reuseRevision ? { reuseRevision } : {}) })
      }
      const job = { id, status: 'planned', source: bundle.source, destination, createdAt: now(), updatedAt: now(), items, warnings: ['Copies preserve the source. Credentials and sandbox memberships are not copied. Source organization blocks become rules scoped to imported groups; destination organization settings stay unchanged. Historical activity is included only when selected.'], cancelRequested: false }
      await save(job)
      return jobView(job)
    },
    async list() {
      const names = await fs.readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error })
      const jobs = await Promise.all(names.filter(name => /^[a-f0-9]{32}\.json$/.test(name)).map(async name => jobView(await read(name.slice(0, -5)))))
      return { jobs: jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100) }
    },
    async get(id) { return jobView(await read(id)) },
    async execute(id, input, retry = false) {
      return queue(directory, async () => {
        if (input?.acknowledged !== true) throw importFail('Review the import plan and acknowledge the changes before starting.')
        if (running.has(key(id))) return jobView(running.get(key(id)))
        if ([...running.keys()].filter(file => path.dirname(file) === directory).length >= 2) throw importFail('Two imports are already running at this destination. Wait or cancel one before starting another.', 429)
        const job = await read(id)
        if (job.status === 'completed') return jobView(job)
        if (retry ? !terminal.has(job.status) : job.status !== 'planned') throw importFail('Use retry to resume this import.', 409)
        if (retry) for (const item of job.items) if (!['created', 'reused'].includes(item.status)) { item.status = 'pending'; item.error = null }
        job.status = 'running'; job.cancelRequested = false
        running.set(key(id), job)
        try { await save(job) } catch (error) { running.delete(key(id)); throw error }
        const response = jobView(job)
        void runWithContext(context, () => run(job))
        await emit(job, retry ? 'import.retry' : 'import.started')
        return response
      })
    },
    async cancel(id) {
      return queue(directory, async () => {
        const active = running.get(key(id)), job = active || await read(id)
        if (terminal.has(job.status)) return jobView(job)
        job.cancelRequested = true
        if (!active) { job.status = 'cancelled'; for (const item of job.items) if (item.status === 'pending') item.status = 'cancelled' }
        await save(job)
        return jobView(job)
      })
    },
  }
  // A retained service is destination-bound even after the console changes its
  // selected gateway; async storage and background jobs use the captured scope.
  for (const method of ['export', 'plan', 'list', 'get', 'execute', 'cancel']) {
    const operation = service[method]
    service[method] = (...args) => runWithContext(context, () => operation(...args))
  }
  return service
}

export async function resourceImportRoute(method, parts, input, options) {
  if (parts[0] !== 'resource-imports') return undefined
  const service = createResourceImports(options)
  if (method === 'GET' && parts.length === 1) return service.list()
  if (method === 'GET' && parts[1] === 'capabilities' && parts.length === 2) return service.capabilities()
  if (method === 'GET' && parts.length === 2) return service.get(parts[1])
  if (method === 'POST' && parts.length === 2 && parts[1] === 'export') return service.export(input)
  if (method === 'POST' && parts.length === 2 && parts[1] === 'plan') return service.plan(input)
  if (method === 'POST' && parts.length === 3 && parts[2] === 'execute') return service.execute(parts[1], input)
  if (method === 'POST' && parts.length === 3 && parts[2] === 'retry') return service.execute(parts[1], input, true)
  if (method === 'POST' && parts.length === 3 && parts[2] === 'cancel') return service.cancel(parts[1])
  throw importFail('Unknown import operation.', 404)
}
