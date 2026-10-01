import test from 'node:test'
import assert from 'node:assert/strict'
import { setupAccessIdentity, launchSetupAccess, setupPolicyCoverage } from './setup-deployment.js'

test('gateway map reordering does not invalidate access; actual access changes do', () => {
  const first = { policy: { networkPolicies: { claude: { endpoints: [{ host: 'example.com', port: 443 }] }, codex: { binaries: [{ path: '/usr/bin/codex' }] } } }, targets: ['claude', 'codex'] }
  const reordered = { targets: ['claude', 'codex'], policy: { networkPolicies: { codex: { binaries: [{ path: '/usr/bin/codex' }] }, claude: { endpoints: [{ port: 443, host: 'example.com' }] } } } }
  assert.equal(setupAccessIdentity(first), setupAccessIdentity(reordered))
  for (const field of ['host', 'port']) {
    const changed = structuredClone(first)
    changed.policy.networkPolicies.claude.endpoints[0][field] = field === 'host' ? 'other.example.com' : 8443
    assert.notEqual(setupAccessIdentity(first), setupAccessIdentity(changed))
  }
  const removed = structuredClone(first)
  delete removed.policy.networkPolicies.codex
  assert.notEqual(setupAccessIdentity(first), setupAccessIdentity(removed))
})

test('template launch access is limited to pinned inherited setups', () => {
  const setups = [{ id: 'baked', revision: 'v1' }, { id: 'extra', revision: 'v2' }]
  const recipe = { setups: ['baked'], setupRevisions: { baked: 'v1' } }
  assert.deepEqual(launchSetupAccess(setups, recipe, null, true), { baked: 'v1' })
  assert.deepEqual(launchSetupAccess(setups, recipe, null), {})
  assert.deepEqual(launchSetupAccess(setups, recipe, { baked: 'v1', extra: 'v2' }), { baked: 'v1', extra: 'v2' })
  assert.throws(() => launchSetupAccess(setups, { ...recipe, setupRevisions: { baked: 'changed' } }, null, true), /Rebuild/)
  assert.throws(() => launchSetupAccess(setups, { setups: ['baked'] }, null, true), /Rebuild/)
  assert.throws(() => launchSetupAccess(setups, recipe, { baked: 'v1', extra: 'old' }, true), /Review/)
})

test('a Setup’s egress policy covers its own runtime hosts; anything it would not open keeps the grant flow', () => {
  const id = 'a'.repeat(24), setup = { id }, prepared = { id: 'b'.repeat(24), preparedFrom: { id } }
  const advanced = { ports: [443], programs: [], requests: 'any', allow: [], deny: [], enforcement: 'enforce', privateIps: [] }
  const policy = { id: `setup-${id}`, name: 'MCPs & Skills: Tools', action: 'allow', destinations: ['api.example.com', '**.cdn.example.com'], appliesTo: { everyone: false, groups: [], sandboxes: [], setups: [id] }, advanced }
  const need = (host, port = 443) => ({ phase: 'runtime', host, port }), node = ['/usr/bin/node']
  assert.equal(setupPolicyCoverage(need('api.example.com'), setup, [policy], node), policy)
  assert.equal(setupPolicyCoverage(need('img.eu.cdn.example.com'), prepared, [policy], node), policy)
  for (const [requirement, owner, policies, callers] of [
    [need('api.example.com'), { id: 'c'.repeat(24) }, [policy], node],
    [need('api.example.com', 8443), setup, [policy], node],
    [need('other.example.com'), setup, [policy], node],
    [need('api.example.com'), setup, [{ ...policy, action: 'block' }], node],
    [need('api.example.com'), setup, [{ ...policy, advanced: { ...advanced, programs: ['/usr/bin/python3'] } }], node],
    [need('api.example.com'), setup, [{ ...policy, advanced: { ...advanced, privateIps: ['10.0.0.0/8'] } }], node],
    [need('api.example.com'), setup, [policy], []],
  ]) assert.equal(setupPolicyCoverage(requirement, owner, policies, callers), null)
  const denied = { networkPolicies: { template: { binaries: [{ path: '/**' }], endpoints: [{ host: 'api.example.com', port: 443, protocol: 'rest', enforcement: 1, access: 2, denyRules: [{ method: '*', path: '/**' }] }] } } }
  assert.equal(setupPolicyCoverage(need('api.example.com'), setup, [policy], node, denied), null)
})
