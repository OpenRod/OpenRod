import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// Real routes, storage, compiler and reconciliation; only remote transport
// and the deliberately failing filesystem operation are replaced.
async function fixture(t) {
  const source = path.resolve(import.meta.dirname, '..')
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'setup-policy-lifecycle-')))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const previousData = process.env.OPENSHELL_CONSOLE_DATA_DIR
  process.env.OPENSHELL_CONSOLE_DATA_DIR = path.join(root, 'state')
  t.after(() => {
    if (previousData === undefined) delete process.env.OPENSHELL_CONSOLE_DATA_DIR
    else process.env.OPENSHELL_CONSOLE_DATA_DIR = previousData
  })
  for (const part of ['server', 'shared', 'src/lib']) await fs.cp(path.join(source, part), path.join(root, part), { recursive: true })
  await fs.copyFile(path.join(source, 'package.json'), path.join(root, 'package.json'))
  await fs.symlink(path.join(source, 'node_modules'), path.join(root, 'node_modules'))
  const file = path.join(root, 'server/gateway.js')
  await fs.rename(file, path.join(root, 'server/gateway-original.js'))
  await fs.writeFile(file, `
export * from './gateway-original.js'
import { create } from '@bufbuild/protobuf'
import { NetworkPolicyRuleSchema } from '@nvidia/openshell-sdk/raw'
export const state = { rules: {}, attempts: 0, down: false }
const sandbox = { metadata: { name: 'box', id: 'box-id', createdTime: { seconds: 1n } }, status: { phase: 2 } }
const raw = {
  async listSandboxes() { return { sandboxes: [sandbox] } },
  async getSandbox() { return { sandbox } },
  async getSandboxPolicyStatus() { await state.beforeStatus?.(); return { revision: { policy: { networkPolicies: state.rules } } } },
  async updateConfig(input) {
    state.attempts++
    if (state.down) throw new Error('Gateway temporarily unavailable')
    for (const { operation } of input.mergeOperations ?? []) {
      if (operation.case === 'removeRule') delete state.rules[operation.value.ruleName]
      else state.rules[operation.value.ruleName] = create(NetworkPolicyRuleSchema, operation.value.rule)
    }
    return { version: 2n }
  },
  async getGatewayConfig() { return { settings: { proposal_approval_mode: {value: {value: 'manual'}}, agent_policy_proposals_enabled: {value: {value: false}} } } },
  async getDraftPolicy() { state.afterSweep?.(); return { chunks: [] } },
}
export async function gateway() { return { client: { raw }, target: { endpoint: 'fixture://gateway' } } }
`)
  const module = name => import(pathToFileURL(path.join(root, 'server', name)))
  const { getSetupStore, setupRoute } = await module('setups.js')
  const setupStore = getSetupStore()
  const { policyDirectory } = await module('paths.js')
  const policyDir = await policyDirectory()
  const { orgRoute, syncAll, startOrgSweeper } = await module('org.js')
  const { listPolicies } = await module('egress.js')
  const { state } = await module('gateway.js')
  const { createSetupEgress } = await module('setup-egress.js')
  const item = host => ({ id: host, name: host, kind: 'mcp', issues: [], config: { url: `https://${host}/mcp` }, requirements: [{ phase: 'runtime', host, port: 443 }] })
  async function save(hosts, group = false) {
    const review = setupStore.stage(hosts.map(item))
    const setup = await setupRoute('POST', ['setups', 'save'], { token: review.token, name: 'Work tools', acknowledged: true })
    assert.equal(setup.egressPolicyError, undefined)
    assert.equal(setup.egressPolicy.id, `setup-${setup.id}`)
    if (group) {
      await orgRoute('POST', ['org', 'groups'], { id: 'work', name: 'Work' })
      const policy = (await listPolicies()).find(p => p.setup?.id === setup.id)
      await orgRoute('POST', ['egress', 'policies'], { ...policy, appliesTo: { ...policy.appliesTo, groups: ['work'] } })
      await orgRoute('POST', ['org', 'members'], { sandboxes: ['box'], groups: ['work'] })
    }
    return setup
  }
  const hosts = () => Object.values(state.rules).flatMap(rule => rule.endpoints.map(e => e.host)).sort()
  return { root, policyDir, setupStore, setupRoute, orgRoute, syncAll, startOrgSweeper, listPolicies, state, item, save, hosts, createSetupEgress }
}

test('failed host revocation reconciles after recovery without rewriting equal protobuf rules', async t => {
  const h = await fixture(t)
  const setup = await h.save(['old.example.com', 'keep.example.com'], true)
  h.state.rules.local = { name: 'local', endpoints: [{ host: 'local.example.com' }], binaries: [] }
  h.state.down = true
  await h.setupRoute('POST', ['setups', setup.id, 'delete-item'], { item: 'old.example.com', revision: setup.revision })
  assert.ok(h.hosts().includes('old.example.com'))
  h.state.down = false
  const stop = h.startOrgSweeper(() => {})
  try {
    for (let i = 0; i < 100 && h.hosts().includes('old.example.com'); i++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.deepEqual(h.hosts(), ['keep.example.com', 'local.example.com'])
    const attempts = h.state.attempts
    assert.deepEqual(await h.syncAll({ force: false }), { applied: [], failed: [] })
    assert.equal(h.state.attempts, attempts, 'protobuf defaults must not trigger perpetual reconciliation')
  } finally { stop() }
})

test('automatic recompute and manual policy edits share the write queue', async t => {
  const h = await fixture(t)
  const setup = await h.save(['old.example.com'])
  const manual = (await h.listPolicies())[0]
  let release, captured
  const blocked = new Promise(resolve => { release = resolve })
  const snapshot = new Promise(resolve => { captured = resolve })
  const read = fs.readFile
  let pause = true, watch = true
  fs.readFile = async function(file, ...args) {
    if (String(file) === path.join(h.policyDir, 'org/organization.json') && pause) { pause = false; await blocked }
    const data = await read.call(this, file, ...args)
    if (String(file) === path.join(h.policyDir, 'egress', manual.id + '.json') && watch) { watch = false; captured() }
    return data
  }
  try {
    const recompute = h.createSetupEgress().syncSetupPolicy({ ...setup, items: [h.item('new.example.com')] })
    await snapshot
    const edit = h.orgRoute('POST', ['egress', 'policies'], { ...manual, destinations: [...manual.destinations, 'manual.example.com'], advanced: { ...manual.advanced, ports: [...manual.advanced.ports, 9000] } })
    await Promise.race([edit, new Promise(resolve => setTimeout(resolve, 100))])
    release()
    await Promise.all([recompute, edit])
    const saved = (await h.listPolicies())[0]
    assert.ok(saved.destinations.includes('manual.example.com'))
    assert.ok(saved.advanced.ports.includes(9000))
  } finally { release(); fs.readFile = read }
})

test('failed policy-file deletion leaves the setup present and can be retried', async t => {
  const h = await fixture(t)
  const setup = await h.save(['cleanup.example.com'])
  const rm = fs.rm
  fs.rm = async function(file, ...args) {
    if (String(file) === path.join(h.policyDir, 'egress', `setup-${setup.id}.json`)) throw Object.assign(new Error('Policy file is read-only'), { code: 'EACCES' })
    return rm.call(this, file, ...args)
  }
  try {
    await assert.rejects(h.setupRoute('POST', ['setups', setup.id, 'delete'], { revision: setup.revision }), /read-only/)
    assert.equal((await h.setupStore.get(setup.id)).revision, setup.revision)
  } finally { fs.rm = rm }
  assert.deepEqual(await h.setupRoute('POST', ['setups', setup.id, 'delete'], { revision: setup.revision }), { deleted: setup.id })
  await assert.rejects(h.setupStore.get(setup.id), { status: 404 })
  assert.equal((await h.listPolicies()).length, 0)
})

test('removing the last setup tool or its setup cannot bypass occupied-group coverage', async t => {
  const h = await fixture(t)
  const setup = await h.save(['work.example.com'], true)
  const policy = (await h.listPolicies())[0]
  await assert.rejects(h.orgRoute('POST', ['egress', 'policies', policy.id, 'delete'], {}), /last network rule/)
  await assert.rejects(h.setupRoute('POST', ['setups', setup.id, 'delete-item'], { item: 'work.example.com', revision: setup.revision }), /last network rule/)
  await assert.rejects(h.setupRoute('POST', ['setups', setup.id, 'delete'], { revision: setup.revision }), /last network rule/)
  assert.equal((await h.setupStore.get(setup.id)).items.length, 1)
  assert.equal((await h.listPolicies()).length, 1)
  assert.deepEqual(h.hosts(), ['work.example.com'])
})

test('deleting a setup preserves its policy after a manual switch to Block', async t => {
  const h = await fixture(t)
  const setup = await h.save(['blocked.example.com'])
  const policy = (await h.listPolicies())[0]
  const { policy: block } = await h.orgRoute('POST', ['egress', 'policies'], { ...policy, action: 'block' })
  await h.setupRoute('POST', ['setups', setup.id, 'delete'], { revision: setup.revision })
  assert.deepEqual(await h.listPolicies(), [block], 'a manually changed deny rule is no longer owned by the setup')
})

test('a partial automatic policy write preserves manual edits and the setup for retry', async t => {
  const h = await fixture(t)
  const setup = await h.save(['old.example.com', 'keep.example.com'])
  const policy = (await h.listPolicies())[0]
  const { policy: manual } = await h.orgRoute('POST', ['egress', 'policies'], { ...policy, name: 'Manual name', destinations: [...policy.destinations, 'manual.example.com'] })
  const policyFile = path.join(h.policyDir, 'egress', policy.id + '.json')
  const write = fs.writeFile
  fs.writeFile = async function(file, data, ...args) {
    if (String(file).startsWith(policyFile)) {
      await write.call(this, file, String(data).slice(0, 20), ...args)
      throw Object.assign(new Error('Partial policy write; no space left'), { code: 'ENOSPC' })
    }
    return write.call(this, file, data, ...args)
  }
  try {
    await assert.rejects(h.setupRoute('POST', ['setups', setup.id, 'delete-item'], { item: 'old.example.com', revision: setup.revision }), /no space left/)
  } finally { fs.writeFile = write }
  assert.deepEqual(await h.listPolicies(), [manual])
  assert.equal((await h.setupStore.get(setup.id)).items.length, 2)
  await h.setupRoute('POST', ['setups', setup.id, 'delete-item'], { item: 'old.example.com', revision: setup.revision })
  const retried = (await h.listPolicies())[0]
  assert.equal(retried.name, 'Manual name')
  assert.deepEqual(retried.destinations, ['keep.example.com', 'manual.example.com'])
})

test('an in-flight sweep cannot reopen a host revoked by a concurrent setup edit', async t => {
  const h = await fixture(t)
  const setup = await h.save(['old.example.com', 'keep.example.com'], true)
  let release, paused, finished
  const blocked = new Promise(resolve => { release = resolve })
  const captured = new Promise(resolve => { paused = resolve })
  const swept = new Promise(resolve => { finished = resolve })
  let first = true
  h.state.beforeStatus = async () => { if (first) { first = false; paused(); await blocked } }
  h.state.afterSweep = finished
  const stop = h.startOrgSweeper(() => {})
  try {
    await captured
    const edit = h.setupRoute('POST', ['setups', setup.id, 'delete-item'], { item: 'old.example.com', revision: setup.revision })
    await Promise.race([edit, new Promise(resolve => setTimeout(resolve, 100))])
    release()
    await Promise.all([edit, swept])
    assert.deepEqual(h.hosts(), ['keep.example.com'])
  } finally { release(); stop() }
})

test('a concurrent sandbox port edit cannot restore a revoked setup host', async t => {
  const h = await fixture(t)
  const setup = await h.save(['old.example.com', 'keep.example.com'], true)
  const { policyRoute } = await import(pathToFileURL(path.join(h.root, 'server/policy.js')))
  let release, paused
  const blocked = new Promise(resolve => { release = resolve })
  const captured = new Promise(resolve => { paused = resolve })
  let first = true
  h.state.beforeStatus = async () => { if (first) { first = false; paused(); await blocked } }
  try {
    const portEdit = policyRoute('POST', ['policy', 'box', 'ops'], { ops: [{ kind: 'addRule', rule: { name: 'local_extra', binaries: ['/usr/bin/curl'], endpoints: [{ host: 'extra.example.com', ports: [8443] }] } }] })
    await captured
    const remove = h.setupRoute('POST', ['setups', setup.id, 'delete-item'], { item: 'old.example.com', revision: setup.revision })
    await Promise.race([remove, new Promise(resolve => setTimeout(resolve, 100))])
    release()
    await Promise.all([portEdit, remove])
    assert.deepEqual(h.hosts(), ['extra.example.com', 'keep.example.com'])
  } finally { release() }
})
