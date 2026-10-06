import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createResourceImports, resourceImportRoute } from './resource-imports.js'
import { portableResource, validateImportBundle, fingerprint } from './resource-import-portable.js'
import { newRecipe } from '../src/lib/image-templates.js'

const context = { gateway: 'cloud-worker', workspace: 'team-one' }
const group = { id: 'development', name: 'Development', description: '', template: null }
const setup = { id: '0123456789abcdef01234567', name: 'Tools', items: [{ id: 'mcp-one', kind: 'mcp', name: 'Docs', config: { url: 'https://docs.example.com/mcp' }, issues: [], credentialFields: [], requirements: [] }] }
const network = { id: 'docs', name: 'Docs network', action: 'allow', destinations: ['docs.example.com'], appliesTo: { groups: [group.id], setups: [setup.id], sandboxes: [], everyone: false } }
const template = { name: 'tools', recipe: newRecipe({ name: 'tools', source: 'image', image: 'ubuntu:24.04', command: '', setups: [setup.id] }) }
const bundle = resources => ({ version: 1, source: { kind: 'local', label: 'My computer', context: { gateway: 'local', workspace: 'default' } }, resources: resources.map(([type, raw]) => portableResource(type, raw)) })
async function fixture(t, seed = {}, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openrod-import-test-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const values = { policyTemplates: [], groups: [], network: [], setups: [], templates: [], ...structuredClone(seed) }, calls = []
  const adapter = {
    async list(type) { return structuredClone(values[type]) },
    async create(type, data) { calls.push({ type, data: structuredClone(data) }); values[type].push(structuredClone(data)) },
    ...overrides,
  }
  const make = (opts = {}) => createResourceImports({ directory, context, adapter, ...opts })
  return { service: make(), make, directory, values, calls, adapter }
}
async function completed(service, id) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const job = await service.get(id)
    if (job.status !== 'running') return job
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw Error('Import did not finish')
}

test('plans without mutation and creates dependencies before network/templates with destination IDs', async t => {
  const f = await fixture(t)
  const plan = await f.service.plan({ bundle: bundle([['groups', group], ['network', network], ['setups', setup], ['templates', template]]), selection: ['network:docs', 'templates:tools'] })
  assert.equal(f.calls.length, 0)
  assert.equal(plan.items.length, 4)
  assert.equal(plan.status, 'planned')
  assert.equal('data' in plan.items[0], false)
  await f.service.execute(plan.id, { acknowledged: true })
  const job = await completed(f.service, plan.id)
  assert.equal(job.status, 'completed')
  assert.deepEqual(f.calls.map(call => call.type), ['groups', 'setups', 'network', 'templates'])
  const mappedSetup = job.items.find(item => item.type === 'setups').targetId
  assert.notEqual(mappedSetup, setup.id)
  assert.deepEqual(f.values.network[0].appliesTo.setups, [mappedSetup])
  assert.deepEqual(f.values.templates[0].recipe.setups, [mappedSetup])
  assert.deepEqual(f.values.groups[0].outside, 'block')
})

test('automatically renames collisions without overwriting or reusing by name', async t => {
  const f = await fixture(t, { groups: [group] })
  const plan = await f.service.plan({ bundle: bundle([['groups', group]]) })
  assert.notEqual(plan.items[0].targetId, group.id)
  assert.equal(plan.items[0].action, 'create')
  assert.match(plan.items[0].warnings.join(' '), /existing resource/)
  await f.service.execute(plan.id, { acknowledged: true })
  assert.equal((await completed(f.service, plan.id)).status, 'completed')
  assert.equal(f.values.groups.length, 2)
  assert.deepEqual(f.values.groups[0], group)
})

test('reuses only identical explicitly selected resources and rechecks the revision', async t => {
  const f = await fixture(t, { groups: [group] })
  const plan = await f.service.plan({ bundle: bundle([['groups', group]]), conflicts: { 'groups:development': { action: 'reuse', targetId: group.id } } })
  f.values.groups[0].description = 'Changed after review'
  await f.service.execute(plan.id, { acknowledged: true })
  const job = await completed(f.service, plan.id)
  assert.equal(job.status, 'failed')
  assert.match(job.items[0].error, /changed after review/)
  assert.equal(f.calls.length, 0)
})

test('rejects missing dependencies and unsupported conflict choices before mutation', async t => {
  const f = await fixture(t)
  await assert.rejects(f.service.plan({ bundle: bundle([['network', network]]) }), /Missing dependency/)
  await assert.rejects(f.service.plan({ bundle: bundle([['groups', group]]), conflicts: { 'groups:development': { action: 'replace' } } }), /Unsupported conflict/)
  assert.equal(f.calls.length, 0)
})

test('strips template environment and setup provider refs/values and requires destination preparation', () => {
  const secret = 'super-sensitive-value-must-not-transfer'
  const s = portableResource('setups', { ...setup, items: [{ ...setup.items[0], config: { url: 'https://docs.example.com/mcp', env: { SAFE_SETTING: secret, API_TOKEN: secret }, headers: { Authorization: `Bearer ${secret}` } }, credentialRef: { provider: 'source-secret', aliases: { API_TOKEN: 'SOURCE_TOKEN' } }, credentialBindings: { API_TOKEN: { header: 'Authorization', prefix: 'Bearer ' } } }] })
  assert.equal(JSON.stringify(s).includes(secret), false)
  assert.equal(JSON.stringify(s).includes('source-secret'), false)
  assert.deepEqual(s.data.items[0].credentialFields, ['API_TOKEN'])
  assert.match(s.warnings.join(' '), /reconnect credentials/)
  const result = portableResource('templates', { ...template, recipe: { ...template.recipe, environment: [{ name: 'HOST', value: secret }] } })
  assert.deepEqual(result.data.recipe.environment, [])
  assert.equal(JSON.stringify(result).includes(secret), false)
  const twice = validateImportBundle(bundle([['setups', s.data]]))
  assert.equal(fingerprint(twice.resources[0].data), fingerprint(s.data))
})

test('validates untrusted incoming skill paths, duplicate files and credential contents', () => {
  const skill = files => ({ ...setup, items: [{ kind: 'skill', name: 'Review', files }] })
  assert.throws(() => portableResource('setups', skill([{ path: '../SKILL.md', content: 'hello' }])), /file path/)
  assert.throws(() => portableResource('setups', skill([{ path: 'SKILL.md', content: 'hello' }, { path: 'SKILL.md', content: 'again' }])), /duplicate/)
  assert.throws(() => portableResource('setups', skill([{ path: 'SKILL.md', content: '-----BEGIN PRIVATE KEY-----\nabc' }])), /credentials/)
  const safe = portableResource('setups', skill([{ path: 'SKILL.md', content: '# Review\nRead changes.' }, { path: 'payload.zip', content: 'AAAA', encoding: 'base64' }]))
  assert.equal(safe.data.items[0].files.length, 1)
  assert.match(safe.warnings[0], /excluded/)
})

test('idempotent execute and retry preserve successful resources after partial failures', async t => {
  const f = await fixture(t)
  let fail = true
  const create = f.adapter.create
  f.adapter.create = async (type, data) => { if (type === 'setups' && fail) throw Object.assign(Error('Destination unavailable'), { status: 503 }); return create(type, data) }
  const plan = await f.service.plan({ bundle: bundle([['groups', group], ['setups', setup], ['network', network]]) })
  await f.service.execute(plan.id, { acknowledged: true })
  const partial = await completed(f.service, plan.id)
  assert.equal(partial.status, 'partial')
  assert.equal(partial.items.find(item => item.type === 'network').status, 'blocked')
  fail = false
  await f.service.execute(plan.id, { acknowledged: true }, true)
  assert.equal((await completed(f.service, plan.id)).status, 'completed')
  await f.service.execute(plan.id, { acknowledged: true })
  assert.equal(f.calls.filter(call => call.type === 'groups').length, 1)
  assert.equal(f.values.network.length, 1)
})

test('durable jobs are discoverable after creating a new service instance and are scoped', async t => {
  const f = await fixture(t)
  const plan = await f.service.plan({ bundle: bundle([['groups', group]]) })
  const fresh = f.make()
  assert.equal((await fresh.list()).jobs[0].id, plan.id)
  await assert.rejects(f.make({ context: { ...context, workspace: 'other-account' } }).get(plan.id), /another destination/)
  await assert.rejects(fresh.get('../secrets'), /not found/)
})

test('interrupted create reconciles an identical destination resource instead of duplicating it', async t => {
  const f = await fixture(t)
  const plan = await f.service.plan({ bundle: bundle([['groups', group]]) })
  const file = path.join(f.directory, `${plan.id}.json`)
  const saved = JSON.parse(await fs.readFile(file, 'utf8'))
  saved.status = 'running'; saved.items[0].status = 'running'; saved.items[0].attempted = true
  f.values.groups.push(saved.items[0].data)
  await fs.writeFile(file, JSON.stringify(saved))
  assert.equal((await f.service.get(plan.id)).status, 'interrupted')
  await f.service.execute(plan.id, { acknowledged: true }, true)
  assert.equal((await completed(f.service, plan.id)).status, 'completed')
  assert.equal(f.calls.length, 0)
})

test('a newly occupied target after review is rejected rather than overwritten', async t => {
  const f = await fixture(t)
  const plan = await f.service.plan({ bundle: bundle([['groups', group]]) })
  f.values.groups.push(group)
  await f.service.execute(plan.id, { acknowledged: true })
  const job = await completed(f.service, plan.id)
  assert.equal(job.status, 'failed')
  assert.equal(f.calls.length, 0)
})

test('cancelled plans never create resources and require acknowledgment to resume', async t => {
  const f = await fixture(t)
  const plan = await f.service.plan({ bundle: bundle([['groups', group]]) })
  assert.equal((await f.service.cancel(plan.id)).status, 'cancelled')
  await assert.rejects(f.service.execute(plan.id, {}, true), /acknowledge/)
  assert.equal(f.calls.length, 0)
  await f.service.execute(plan.id, { acknowledged: true }, true)
  assert.equal((await completed(f.service, plan.id)).status, 'completed')
})

test('exports scoped configurations and dependencies, excludes unsupported policy scopes', async t => {
  const f = await fixture(t, { groups: [group], setups: [setup], templates: [template], network: [network, { ...network, id: 'old-rule', appliesTo: { everyone: true } }] })
  const exported = await f.service.export({ types: ['templates'] })
  assert.deepEqual(exported.resources.map(resource => resource.type).sort(), ['setups', 'templates'])
  assert.equal(exported.source.context.workspace, context.workspace)
  const policies = await f.service.export({ types: ['network'] })
  assert.match(policies.excluded[0].reason, /Legacy global/)
  assert.equal(f.calls.length, 0)
})

test('router reports unsupported categories honestly and leaves other routes alone', async () => {
  assert.equal(await resourceImportRoute('GET', ['groups']), undefined)
  const capability = await resourceImportRoute('GET', ['resource-imports', 'capabilities'])
  assert.equal(capability.types.groups.supported, true)
  assert.equal(capability.types.secrets.supported, false)
  assert.equal(capability.types.activity.supported, false)
  assert.equal(capability.limits.bytes, 8 * 1024 * 1024)
})

test('groups with custom pinned base policies require their portable policy dependency', () => {
  const resource = portableResource('groups', { ...group, template: 'custom-base' })
  assert.equal(resource.data.template, 'custom-base')
  assert.deepEqual(resource.dependencies, ['policyTemplates:custom-base'])
})

test('activity is explicit, bounded, redacted, preserves provenance and deduplicates across imports', async t => {
  const { createActivityStore } = await import('./activity-store.js')
  const sourceStore = createActivityStore(':memory:'), destinationStore = createActivityStore(':memory:')
  t.after(() => { sourceStore.close(); destinationStore.close() })
  for (let i = 0; i < 501; i++) sourceStore.ingest({ id: `event-${i}`, at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), sandbox: 'source-sandbox', category: 'CONFIG', action: 'update', message: i === 500 ? 'Authorization: Bearer opaque-secret-value' : `Changed ${i}`, original: { token: 'must-never-leave-source' } }, 'source')
  const f = await fixture(t)
  const source = createResourceImports({ directory: path.join(f.directory, 'source'), context: { gateway: 'local', workspace: 'work' }, activityStore: sourceStore })
  const destination = createResourceImports({ directory: path.join(f.directory, 'destination'), context, activityStore: destinationStore })
  const first = await source.export({ types: ['activity'] })
  assert.equal(source.capabilities().types.activity.supported, true)
  assert.equal(first.resources[0].data.events.length, 500)
  assert.equal(first.pages.activity.total, 501)
  assert.equal(first.pages.activity.nextOffset, 500)
  assert.equal(first.resources[0].data.events[0].message, '[redacted]')
  assert.equal(JSON.stringify(first).includes('must-never-leave-source'), false)
  const plan = await destination.plan({ bundle: first })
  await destination.execute(plan.id, { acknowledged: true })
  assert.equal((await completed(destination, plan.id)).status, 'completed')
  assert.equal(destinationStore.coverage().retained, 500)
  const copied = destinationStore.query({ limit: 1 }).events[0]
  assert.equal(copied.at, first.resources[0].data.events[0].at)
  assert.equal(copied.importedFrom.eventId, first.resources[0].data.events[0].id)
  assert.equal(copied.importedFrom.gateway, 'local')
  assert.match(copied.location.label, /imported/)
  const repeat = await destination.plan({ bundle: first })
  assert.equal(repeat.items[0].action, 'reuse')
  await destination.execute(repeat.id, { acknowledged: true })
  assert.equal((await completed(destination, repeat.id)).status, 'completed')
  assert.equal(destinationStore.coverage().retained, 500)
  const last = await source.export({ types: ['activity'], activity: { snapshot: first.pages.activity.snapshot, offset: first.pages.activity.nextOffset } })
  assert.equal(last.resources[0].data.events.length, 1)
  assert.equal(last.pages.activity.nextOffset, null)
  const final = await destination.plan({ bundle: last })
  await destination.execute(final.id, { acknowledged: true })
  assert.equal((await completed(destination, final.id)).status, 'completed')
  assert.equal(destinationStore.coverage().retained, 501)
})

test('activity rejects invalid dates, oversized batches and duplicate identities', () => {
  const activity = { id: 'history-' + 'a'.repeat(24), name: 'History', origin: { gateway: 'local', workspace: 'default' }, events: [{ id: 'b'.repeat(64), at: '2026-01-01T00:00:00Z', sandbox: 'sandbox' }] }
  assert.throws(() => portableResource('activity', { ...activity, events: [activity.events[0], activity.events[0]] }), /duplicate/)
  assert.throws(() => portableResource('activity', { ...activity, events: [{ ...activity.events[0], at: 'bad-date' }] }), /timestamp/)
  assert.throws(() => portableResource('activity', { ...activity, events: Array(501).fill(activity.events[0]) }), /500/)
})

test('template preparation is persisted before creation and verified against prepared dependencies', async t => {
  const f = await fixture(t, { setups: [setup] })
  const prepared = '9'.repeat(24)
  f.adapter.prepare = async (type, data) => type === 'templates' ? { ...data, recipe: { ...data.recipe, setups: [prepared] } } : data
  const plan = await f.service.plan({ bundle: bundle([['setups', setup], ['templates', template]]) })
  await f.service.execute(plan.id, { acknowledged: true })
  assert.equal((await completed(f.service, plan.id)).status, 'completed')
  assert.deepEqual(f.values.templates[0].recipe.setups, [prepared])
  const persisted = JSON.parse(await fs.readFile(path.join(f.directory, `${plan.id}.json`), 'utf8'))
  assert.deepEqual(persisted.items.find(item => item.type === 'templates').data.recipe.setups, [prepared])
})

test('source organization restrictions are mandatory when an imported group is selected', async t => {
  const f = await fixture(t, { groups: [group, { ...group, id: 'other', name: 'Other' }] })
  f.adapter.organizationRules = async () => ['development', 'other'].map(id => ({ id: `restriction-${id}`, name: 'Source organization blocks', action: 'block', destinations: ['blocked.example.com'], appliesTo: { groups: [id] }, sourceOrganizationBlock: true }))
  const exported = await f.service.export({ types: ['groups'], selection: ['groups:development'] })
  assert.deepEqual(exported.resources.map(resource => resource.key).sort(), ['groups:development', 'network:restriction-development'])
  const plan = await f.service.plan({ bundle: exported, selection: ['groups:development'] })
  assert.equal(plan.items.length, 2)
  assert.equal(plan.items[1].type, 'network')
  await f.service.execute(plan.id, { acknowledged: true })
  assert.equal((await completed(f.service, plan.id)).status, 'completed')
  assert.deepEqual(f.values.network[0].appliesTo.groups, [plan.items[0].targetId])
  assert.equal(f.values.network[0].action, 'block')
})

test('limits active imports per destination and concurrent execute does not start duplicate work', async t => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const f = await fixture(t)
  const create = f.adapter.create
  f.adapter.create = async (type, data) => { await gate; return create(type, data) }
  const plans = await Promise.all(['one', 'two', 'three'].map(id => f.service.plan({ bundle: bundle([['groups', { ...group, id }]]) })))
  const first = await Promise.all([f.service.execute(plans[0].id, { acknowledged: true }), f.service.execute(plans[0].id, { acknowledged: true })])
  assert.equal(first[0].id, first[1].id)
  await f.service.execute(plans[1].id, { acknowledged: true })
  await assert.rejects(f.service.execute(plans[2].id, { acknowledged: true }), error => error.status === 429)
  release()
  await Promise.all(plans.slice(0, 2).map(plan => completed(f.service, plan.id)))
  assert.equal(f.calls.length, 2)
})

test('a poll that overlaps the final save never reports a finished import as interrupted', async t => {
  let release, finished
  const gate = new Promise(resolve => { release = resolve }), done = new Promise(resolve => { finished = resolve })
  const f = await fixture(t)
  const create = f.adapter.create
  f.adapter.create = async (type, data) => { await gate; return create(type, data) }
  const plan = await f.service.plan({ bundle: bundle([['groups', group]]) })
  await f.service.execute(plan.id, { acknowledged: true })
  // Hold one poll's read of the 'running' file until the job has finished.
  const readFile = fs.readFile
  t.after(() => { fs.readFile = readFile })
  fs.readFile = async (...args) => { fs.readFile = readFile; const content = await readFile(...args); await done; return content }
  const poll = f.service.get(plan.id)
  release()
  assert.equal((await completed(f.service, plan.id)).status, 'completed')
  finished()
  assert.equal((await poll).status, 'running')
  assert.equal((await f.service.get(plan.id)).status, 'completed')
})

test('rejects JSON-shaped embedded secrets in skill content', () => {
  assert.throws(() => portableResource('setups', { ...setup, items: [{ kind: 'skill', name: 'Review', files: [{ path: 'SKILL.md', content: '{"api_key":"opaqueSecretValue123456789"}' }] }] }), /credentials/)
})

test('cancellation as preparation finishes does not start creating the resource', async t => {
  let release, preparing
  const started = new Promise(resolve => { preparing = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const f = await fixture(t)
  f.adapter.prepare = async (_type, data) => { preparing(); await gate; return data }
  const plan = await f.service.plan({ bundle: bundle([['groups', group]]) })
  await f.service.execute(plan.id, { acknowledged: true })
  await started
  await f.service.cancel(plan.id)
  release()
  const job = await completed(f.service, plan.id)
  assert.equal(job.status, 'cancelled')
  assert.equal(job.items[0].status, 'cancelled')
  assert.equal(f.calls.length, 0)
})
