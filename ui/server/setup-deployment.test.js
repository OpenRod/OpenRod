import test from 'node:test'
import assert from 'node:assert/strict'
import { setupAccessIdentity, launchSetupAccess } from './setup-deployment.js'

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
