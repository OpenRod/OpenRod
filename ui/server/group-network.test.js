import test from 'node:test'
import assert from 'node:assert/strict'
import { assertPolicyGroup, assertSandboxGroup, assertPolicyCoverage } from '../shared/group-network.js'
import { planSandbox, orgRoute } from './org.js'
import { compileFor } from './egress.js'
import { validatePolicy } from './egress.js'

const groups = [{ id: 'frontend' }, { id: 'data' }]
const policy = validatePolicy({ id: 'npm', name: 'npm', action: 'allow', destinations: ['registry.npmjs.org'], appliesTo: { groups: ['frontend'] } })

test('network writes require one or more existing groups without bypass scopes', () => {
  assert.doesNotThrow(() => assertPolicyGroup(policy, groups))
  for (const appliesTo of [
    { everyone: true, groups: ['frontend'], sandboxes: [] },
    { everyone: false, groups: [], sandboxes: [] },
    { everyone: false, groups: ['frontend', 'missing'], sandboxes: [] },
    { everyone: false, groups: ['missing'], sandboxes: [] },
    { everyone: false, groups: ['frontend'], sandboxes: ['web'] },
  ]) assert.throws(() => assertPolicyGroup({ ...policy, appliesTo }, groups))
})

test('launch and reassignment require a group with its own network policy', () => {
  for (const group of [null, 'missing', 'data']) assert.throws(() => assertSandboxGroup(group, groups, [policy]))
  assert.throws(() => assertSandboxGroup('frontend', groups, [{ ...policy, appliesTo: { everyone: true, groups: [], sandboxes: [] } }]))
  assert.doesNotThrow(() => assertSandboxGroup('frontend', groups, [policy]))
  assert.ok(compileFor({ name: 'web', group: 'frontend' }, [policy]).egress_npm)
  assert.equal(compileFor({ name: 'etl', group: 'data' }, [policy]).egress_npm, undefined)
})

test('deletion and reassignment cannot remove the last policy of an occupied group', () => {
  assert.throws(() => assertPolicyCoverage([policy], [], ['frontend']), /last network rule/)
  const moved = { ...policy, appliesTo: { ...policy.appliesTo, groups: ['data'] } }
  assert.throws(() => assertPolicyCoverage([policy], [moved], ['frontend']))
  assert.doesNotThrow(() => assertPolicyCoverage([policy], [], []))
  assert.doesNotThrow(() => assertPolicyCoverage([policy], [policy], ['frontend']))
})

test('server launch rejects missing and unknown required groups before provisioning', async () => {
  await assert.rejects(planSandbox({ name: 'invalid', requireGroup: true }), /Choose at least one group/)
  await assert.rejects(planSandbox({ name: 'invalid', group: 'nonexistent-test-group', requireGroup: true }), /Unknown group/)
})

test('membership and policy routes reject group bypasses before writes', async () => {
  await assert.rejects(orgRoute('POST', ['org', 'members'], { sandboxes: ['web'], group: null }), /Choose at least one group/)
  await assert.rejects(orgRoute('POST', ['egress', 'policies'], { ...policy, id: 'invalid-test-policy', appliesTo: { everyone: true, groups: [], sandboxes: [] } }), /at least one group/)
})


test('one network policy reaches every selected group and protects each occupied group', () => {
  const shared = { ...policy, appliesTo: { everyone: false, groups: ['frontend', 'data'], sandboxes: [] } }
  assert.doesNotThrow(() => assertPolicyGroup(shared, groups))
  for (const group of ['frontend', 'data']) {
    assert.doesNotThrow(() => assertSandboxGroup(group, groups, [shared]))
    assert.ok(compileFor({ name: group, group }, [shared]).egress_npm)
  }
  assert.equal(compileFor({ name: 'other', group: 'other' }, [shared]).egress_npm, undefined)
  assert.throws(() => assertPolicyCoverage([shared], [policy], ['data']), /last network rule/)
  assert.doesNotThrow(() => assertPolicyCoverage([shared], [policy], ['frontend']))
})

test('a sandbox can inherit from multiple groups but cannot lose its last policy', () => {
  assert.doesNotThrow(() => assertSandboxGroup(['frontend', 'data'], groups, [policy]))
  assert.throws(() => assertSandboxGroup(['frontend', 'unknown'], groups, [policy]), /Unknown group/)
  assert.throws(() => assertSandboxGroup([], groups, [policy]), /at least one group/)
  assert.throws(() => assertSandboxGroup(['data'], groups, [policy]), /network rule/)
  const dataRule = { ...policy, id: 'data', appliesTo: { ...policy.appliesTo, groups: ['data'] } }
  assert.doesNotThrow(() => assertPolicyCoverage([policy, dataRule], [dataRule], [['frontend', 'data']]))
  assert.throws(() => assertPolicyCoverage([policy, dataRule], [], [['frontend', 'data']]), /last network rule/)
})
