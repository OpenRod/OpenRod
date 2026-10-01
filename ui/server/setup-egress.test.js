import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { appliesTo } from '../src/lib/egress.js'
import { compileFor, listPolicies, validatePolicy, writePolicy } from './egress.js'
import { createSetupMembers } from './setup-members.js'
import { approvalHosts, createSetupEgress, setupHosts, setupPolicyFor, setupPolicyId } from './setup-egress.js'

const A = 'a'.repeat(24), B = 'b'.repeat(24)
const mcp = (name, requirements, over = {}) => ({ id: name, name, kind: 'mcp', config: { url: `https://${name}.example.com/mcp` }, issues: [], requirements, ...over })
const runtime = (host, port = 443) => ({ phase: 'runtime', host, port })
const setup = (items, over = {}) => ({ id: A, name: 'Work tools', revision: 'r', items, ...over })

async function tmp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'setup-egress-test-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  return dir
}

async function harness(t, { blocked = [], members = {}, sync } = {}) {
  const dir = await tmp(t)
  const calls = []
  const egress = createSetupEgress({ dir, org: async () => ({ blocked, outside: 'block' }), members: async () => members, sync: sync ?? (async (opts) => { calls.push(opts); return { applied: ['box'], failed: [] } }) })
  return { dir, calls, ...egress, read: async () => (await listPolicies(dir)).find((p) => p.id === setupPolicyId(A)) ?? null }
}

test('a policy reaches the sandboxes that use one of its setups', () => {
  const p = { appliesTo: { everyone: false, groups: [], sandboxes: [], setups: [A] } }
  assert.ok(appliesTo(p, { name: 'x', group: null, setups: [B, A] }))
  assert.ok(!appliesTo(p, { name: 'x', group: null, setups: [B] }))
  assert.ok(!appliesTo(p, { name: 'x', group: null }))
  assert.ok(!appliesTo({ appliesTo: { everyone: false, groups: [], sandboxes: [] } }, { name: 'x', group: null, setups: [A] }))
})

test('a setups-only policy with its setup marker survives validation', () => {
  const input = { id: setupPolicyId(A), name: 'MCPs & Skills: Work', action: 'allow', destinations: ['mcp.linear.app', 'extra.example.com'], appliesTo: { setups: [A, A] }, advanced: { ports: [443] }, setup: { id: A, name: ' Work ', required: ['MCP.Linear.app.'] } }
  const policy = validatePolicy(input)
  assert.deepEqual(policy.appliesTo, { everyone: false, groups: [], sandboxes: [], setups: [A] })
  assert.deepEqual(policy.setup, { id: A, name: 'Work', required: ['mcp.linear.app'], ports: [] })
  assert.throws(() => validatePolicy({ ...input, setup: { ...input.setup, ports: [0] } }), /Ports must be/)
  assert.deepEqual(validatePolicy(policy), policy)
  assert.deepEqual(validatePolicy({ ...input, setup: undefined }).setup, undefined)
  assert.deepEqual(validatePolicy({ id: 'p', name: 'P', action: 'allow', destinations: ['a.com'] }).appliesTo.setups, [])
  assert.ok(compileFor({ name: 'box', group: null, setups: [A] }, [policy])[`egress_${policy.id}`])
  assert.deepEqual(compileFor({ name: 'box', group: null }, [policy]), {})
})

test('bad setup ids and markers are refused', () => {
  const base = { id: 'p', name: 'P', action: 'allow', destinations: ['a.com'] }
  assert.throws(() => validatePolicy({ ...base, appliesTo: { setups: ['nope'] } }), /not an MCPs & Skills setup/)
  assert.throws(() => validatePolicy({ ...base, appliesTo: { setups: [A.toUpperCase()] } }), /not an MCPs & Skills setup/)
  assert.throws(() => validatePolicy({ ...base, setup: { id: 'x', name: 'n', required: [] } }), /Unknown MCPs & Skills setup/)
  assert.throws(() => validatePolicy({ ...base, setup: { id: A, name: 'a\x07b', required: [] } }), /control characters/)
  assert.throws(() => validatePolicy({ ...base, setup: { id: A, name: 'n', required: ['not a host'] } }), /is not a host/)
  assert.throws(() => setupPolicyId('../x'), /Unknown MCPs & Skills setup/)
})

test('setup members are added, removed, replaced and forgotten, ignoring invalid ids', async (t) => {
  const file = path.join(await tmp(t), 'state', 'setup-members.json')
  const store = createSetupMembers(file)
  const box = (name) => ({ name, id: `id-${name}`, gateway: 'https://gateway.example' })
  const key = (name) => JSON.stringify([box(name).gateway, box(name).id])
  assert.deepEqual(await store.readSetupMembers(), {})
  assert.deepEqual(await store.addSandboxSetups(box('web'), [A, 'bogus', A]), [A])
  assert.deepEqual(await store.addSandboxSetups(box('web'), [B]), [A, B])
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600)
  assert.equal((await fs.stat(path.dirname(file))).mode & 0o777, 0o700)
  assert.deepEqual(await store.removeSandboxSetups(box('web'), [A]), [B])
  assert.deepEqual(await store.setSandboxSetups(box('etl'), [A, '../../x']), [A])
  assert.deepEqual(await store.readSetupMembers(), { [key('etl')]: [A], [key('web')]: [B] })
  assert.deepEqual(await store.setSandboxSetups(box('web'), []), [])
  await store.forgetSandbox(box('etl'))
  await store.forgetSandbox('Not A Name')
  assert.deepEqual(await store.readSetupMembers(), {})
  await assert.rejects(store.addSandboxSetups(box('../web'), [A]), /sandbox identity/)
  await Promise.all([store.addSandboxSetups(box('a'), [A]), store.addSandboxSetups(box('b'), [B]), store.addSandboxSetups(box('a'), [B])])
  assert.deepEqual(await store.readSetupMembers(), { [key('a')]: [A, B], [key('b')]: [B] })
  await fs.writeFile(file, JSON.stringify({ [key('a')]: [A, 'x'], 'Bad Name': [A], empty: ['x'] }))
  assert.deepEqual(await store.readSetupMembers(), { [key('a')]: [A] })
})

test('only runtime hosts and an MCP’s own sign-in host of usable items count, never build hosts', () => {
  const s = setup([
    mcp('linear', [runtime('mcp.linear.app'), { phase: 'auth', host: 'MCP.linear.app', port: 443, path: '/.well-known/**' }, { phase: 'auth', host: 'auth.linear.app', port: 443 }]),
    mcp('magicui', [runtime('magicui.design'), { phase: 'build', host: 'registry.npmjs.org', port: 443 }, runtime('mcp.linear.app')]),
    mcp('github', [runtime('api.github.com')], { credentialRef: { provider: 'mcp-github' }, credentialFields: ['GITHUB_TOKEN'] }),
    mcp('off', [runtime('off.example.com')], { disabled: true }),
    mcp('broken', [runtime('broken.example.com')], { issues: ['Needs review'] }),
  ])
  assert.deepEqual(setupHosts(s), [
    { host: 'mcp.linear.app', port: 443, items: ['linear', 'magicui'] },
    { host: 'magicui.design', port: 443, items: ['magicui'] },
  ])
  // A sign-in service the MCP's metadata named, and a host that gets credentials, are approved per sandbox.
  assert.deepEqual(approvalHosts(s), [
    { host: 'auth.linear.app', port: 443, items: ['linear'] },
    { host: 'api.github.com', port: 443, items: ['github'] },
  ])
})

test('a setup policy is created, keeps hosts people add, drops hosts no longer needed, and goes when empty', async (t) => {
  const h = await harness(t, { members: { box: [A] } })
  const first = await h.syncSetupPolicy(setup([mcp('linear', [runtime('mcp.linear.app')]), mcp('magicui', [runtime('magicui.design'), { phase: 'build', host: 'registry.npmjs.org', port: 443 }])]))
  assert.equal(first.created, true)
  assert.equal(first.name, 'MCPs & Skills: Work tools')
  assert.deepEqual(first.destinations, ['mcp.linear.app', 'magicui.design'])
  assert.deepEqual(first.hosts, [{ host: 'mcp.linear.app', items: ['linear'] }, { host: 'magicui.design', items: ['magicui'] }])
  assert.deepEqual(first.blocked, [])
  assert.deepEqual(first.sync, { applied: ['box'], failed: [] })
  assert.ok(h.calls[0].only({ name: 'box', group: null, setups: [A] }))
  assert.ok(!h.calls[0].only({ name: 'other', group: null, setups: [B] }))
  const stored = await h.read()
  assert.deepEqual(stored.appliesTo, { everyone: false, groups: [], sandboxes: [], setups: [A] })
  assert.deepEqual(stored.advanced.ports, [443])
  assert.deepEqual(stored.setup, { id: A, name: 'Work tools', required: ['mcp.linear.app', 'magicui.design'], ports: [443] })
  assert.deepEqual(first.approval, [])

  // Someone renames it and adds a host in Egress.
  await writePolicy({ ...stored, name: 'Linear and friends', destinations: [...stored.destinations, 'files.example.com'], advanced: { ...stored.advanced, ports: [8443] } }, h.dir)
  const second = await h.syncSetupPolicy(setup([mcp('linear', [runtime('mcp.linear.app'), runtime('api.linear.app')])]))
  assert.equal(second.created, false)
  assert.equal(second.name, 'Linear and friends')
  assert.deepEqual(second.destinations, ['mcp.linear.app', 'api.linear.app', 'files.example.com'])
  const updated = await h.read()
  assert.deepEqual(updated.advanced.ports, [8443, 443])
  assert.deepEqual(updated.setup.required, ['mcp.linear.app', 'api.linear.app'])

  // Unchanged: nothing written, no sync.
  const calls = h.calls.length
  assert.deepEqual((await h.syncSetupPolicy(setup([mcp('linear', [runtime('mcp.linear.app'), runtime('api.linear.app')])]))).sync, { applied: [], failed: [] })
  assert.equal(h.calls.length, calls)

  // Only the added host is left once the setup needs nothing.
  assert.deepEqual((await h.syncSetupPolicy(setup([mcp('notes', [])]))).destinations, ['files.example.com'])
  assert.deepEqual((await h.syncSetupPolicy(setup([mcp('linear', [runtime('mcp.linear.app')])]))).destinations, ['mcp.linear.app', 'files.example.com'])
  // Once the added host is removed in Egress too, the policy goes with the last need.
  await writePolicy({ ...(await h.read()), destinations: ['mcp.linear.app'] }, h.dir)
  const before = h.calls.length
  assert.equal(await h.syncSetupPolicy(setup([mcp('notes', [])])), null)
  assert.equal(await h.read(), null)
  assert.equal(h.calls.length, before + 1)
  assert.ok(h.calls.at(-1).only({ name: 'box', group: null, setups: [A] }))
})

test('a setup with no network needs gets no policy, and a snapshot uses its source setup’s', async (t) => {
  const h = await harness(t)
  assert.equal(await h.syncSetupPolicy(setup([mcp('npm-only', [{ phase: 'build', host: 'registry.npmjs.org', port: 443 }])])), null)
  assert.equal(await h.syncSetupPolicy(setup([mcp('linear', [runtime('mcp.linear.app')])], { id: B, preparedFrom: { id: A, revision: 'r' } })), null)
  assert.deepEqual(await listPolicies(h.dir), [])
  await assert.rejects(h.syncSetupPolicy({ id: 'x', name: 'n', items: [] }), /Unknown MCPs & Skills setup/)
})

test('hosts the organization blocks are left out and reported', async (t) => {
  const h = await harness(t, { blocked: ['linear.app'] })
  const result = await h.syncSetupPolicy(setup([mcp('linear', [runtime('mcp.linear.app')]), mcp('magicui', [runtime('magicui.design')])]))
  assert.deepEqual(result.blocked, ['mcp.linear.app'])
  assert.deepEqual(result.destinations, ['magicui.design'])
  assert.deepEqual((await h.read()).setup.required, ['magicui.design'])
  const all = await harness(t, { blocked: ['**.example.com'] })
  assert.equal(await all.syncSetupPolicy(setup([mcp('x', [runtime('mcp.example.com')])])), null)
})

test('a block policy for everyone counts as an organization block', async (t) => {
  const h = await harness(t)
  await writePolicy(validatePolicy({ id: 'no-linear', name: 'No Linear', action: 'block', destinations: ['mcp.linear.app'], appliesTo: { everyone: true } }), h.dir)
  await writePolicy(validatePolicy({ id: 'web-only', name: 'Web only', action: 'block', destinations: ['magicui.design'], appliesTo: { groups: ['web'] } }), h.dir)
  const result = await h.syncSetupPolicy(setup([mcp('linear', [runtime('mcp.linear.app')]), mcp('magicui', [runtime('magicui.design')])]))
  assert.deepEqual(result.blocked, ['mcp.linear.app'])
  assert.deepEqual(result.destinations, ['magicui.design'])
})

test('sandboxes are synced only when one can be reached, and a gateway failure never throws', async (t) => {
  const quiet = await harness(t, { members: { box: [B] } })
  assert.deepEqual((await quiet.syncSetupPolicy(setup([mcp('linear', [runtime('mcp.linear.app')])]))).sync, { applied: [], failed: [] })
  assert.equal(quiet.calls.length, 0)
  const down = await harness(t, { members: { box: [A] }, sync: async () => { throw new Error('gateway unreachable') } })
  const result = await down.syncSetupPolicy(setup([mcp('linear', [runtime('mcp.linear.app')])]))
  assert.deepEqual(result.sync, { error: 'gateway unreachable' })
  assert.ok(await down.read())
  assert.deepEqual((await down.removeSetupPolicy(A)), { removed: true, sync: { error: 'gateway unreachable' } })
  assert.equal(await down.read(), null)
  assert.deepEqual(await down.removeSetupPolicy(A), { removed: false, sync: { applied: [], failed: [] } })
  await assert.rejects(down.removeSetupPolicy('nope'), /Unknown MCPs & Skills setup/)
})

test('a setup’s policy covers its own requirements and those of its Quick-setup snapshots', async (t) => {
  const h = await harness(t)
  await h.syncSetupPolicy(setup([mcp('linear', [runtime('mcp.linear.app')])]))
  const policies = await listPolicies(h.dir)
  assert.ok(setupPolicyFor(policies, { id: A }, runtime('mcp.linear.app')))
  assert.ok(setupPolicyFor(policies, { id: B, preparedFrom: { id: A } }, runtime('mcp.linear.app')))
  assert.equal(setupPolicyFor(policies, { id: B }, runtime('mcp.linear.app')), null)
  assert.equal(setupPolicyFor(policies, { id: A }, runtime('mcp.linear.app', 8443)), null)
  assert.equal(setupPolicyFor(policies, { id: A }, runtime('other.example.com')), null)
})

test('ports only a removed MCP needed close, and ports people added stay', async (t) => {
  const h = await harness(t)
  await h.syncSetupPolicy(setup([mcp('odd', [runtime('odd.example.org', 8443)]), mcp('linear', [runtime('mcp.linear.app')])]))
  assert.deepEqual((await h.read()).advanced.ports, [8443, 443])
  await writePolicy({ ...(await h.read()), advanced: { ...(await h.read()).advanced, ports: [8443, 443, 9000] } }, h.dir)
  await h.syncSetupPolicy(setup([mcp('linear', [runtime('mcp.linear.app')])]))
  assert.deepEqual((await h.read()).advanced.ports, [9000, 443])
})

test('a rule switched to Block, or a rule that only shares the id, is never rewritten or deleted', async (t) => {
  const h = await harness(t)
  await h.syncSetupPolicy(setup([mcp('linear', [runtime('mcp.linear.app')])]))
  const blocked = validatePolicy({ ...(await h.read()), action: 'block' })
  await writePolicy(blocked, h.dir)
  await assert.rejects(h.syncSetupPolicy(setup([mcp('linear', [runtime('mcp.linear.app'), runtime('api.linear.app')])])), /left unchanged/)
  assert.deepEqual(await h.read(), blocked)
  const foreign = validatePolicy({ id: setupPolicyId(A), name: 'Mine', action: 'block', destinations: ['pastebin.com'], appliesTo: { everyone: true } })
  await writePolicy(foreign, h.dir)
  await assert.rejects(h.syncSetupPolicy(setup([mcp('linear', [runtime('mcp.linear.app')])])), /left unchanged/)
  assert.deepEqual(await h.removeSetupPolicy(A), { removed: false, sync: { applied: [], failed: [] } })
  assert.deepEqual(await h.read(), foreign)
})
