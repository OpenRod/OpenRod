import test from 'node:test'
import assert from 'node:assert/strict'
import { GROUP_LABEL, groupsOf } from './org.js'
import { appliesTo, compileFor, validatePolicy } from './egress.js'

const groups = [{ id: 'frontend' }, { id: 'data' }]
const sandbox = (name, label) => ({ name, labels: label ? { [GROUP_LABEL]: label } : {} })

test('a stored membership decides the group', () => {
  assert.deepEqual(groupsOf(sandbox('web'), { web: 'frontend' }, groups), ['frontend'])
})

test('a stored membership overrides the creation label, including "no group"', () => {
  assert.deepEqual(groupsOf(sandbox('web', 'frontend'), { web: 'data' }, groups), ['data'])
  assert.deepEqual(groupsOf(sandbox('web', 'frontend'), { web: null }, groups), [])
})

test('without a stored membership the creation label still counts', () => {
  assert.deepEqual(groupsOf(sandbox('web', 'frontend'), {}, groups), ['frontend'])
})

test('a group that no longer exists counts as none', () => {
  assert.deepEqual(groupsOf(sandbox('web'), { web: 'gone' }, groups), [])
  assert.deepEqual(groupsOf(sandbox('web', 'gone'), {}, groups), [])
})

test('a policy aimed at a group reaches its members and nobody else', () => {
  const policy = validatePolicy({ id: 'npm', name: 'npm', action: 'allow', destinations: ['registry.npmjs.org'], appliesTo: { groups: ['frontend'] } })
  const members = { web: 'frontend', etl: 'data' }
  const inGroup = { name: 'web', group: groupsOf(sandbox('web'), members, groups) }
  const outside = { name: 'etl', group: groupsOf(sandbox('etl'), members, groups) }
  assert.ok(appliesTo(policy, inGroup))
  assert.ok(!appliesTo(policy, outside))
  assert.ok(compileFor(inGroup, [policy]).egress_npm)
  assert.equal(compileFor(outside, [policy]).egress_npm, undefined)
})

test('membership arrays override labels and discard deleted groups without duplicates', () => {
  assert.deepEqual(groupsOf(sandbox('web', 'frontend'), { web: ['data', 'frontend', 'data', 'gone'] }, groups), ['data', 'frontend'])
  assert.deepEqual(groupsOf(sandbox('web', 'frontend'), { web: [] }, groups), [])
})

test('new creation labels round-trip multiple groups and old labels still resolve', async () => {
  const { labelsForGroups, groupsFromLabels } = await import('../shared/group-membership.js')
  const labels = labelsForGroups(['frontend', 'data'])
  assert.deepEqual(groupsFromLabels(labels), ['frontend', 'data'])
  assert.deepEqual(groupsOf({ name: 'web', labels }, {}, groups), ['frontend', 'data'])
  assert.deepEqual(groupsFromLabels({ [GROUP_LABEL]: 'frontend' }), ['frontend'])
})

test('adding and removing groups preserves other memberships', async () => {
  const { changeGroups } = await import('../shared/group-membership.js')
  assert.deepEqual(changeGroups('frontend', ['data'], 'add'), ['frontend', 'data'])
  assert.deepEqual(changeGroups(['frontend', 'data'], ['data'], 'add'), ['frontend', 'data'])
  assert.deepEqual(changeGroups(['frontend', 'data'], ['frontend'], 'remove'), ['data'])
  assert.deepEqual(changeGroups(['frontend', 'data'], ['data'], 'replace'), ['data'])
  assert.throws(() => changeGroups([], [], 'invalid'), /Unknown membership/)
})

test('multi-group policies compile once; blocks from a second group cover allowed ports', async () => {
  const { blockedByPolicy } = await import('./egress.js')
  const allow = validatePolicy({ id: 'shared', name: 'Shared', action: 'allow', destinations: ['example.com'], appliesTo: { groups: ['frontend', 'data'] }, advanced: { ports: [8443] } })
  const block = validatePolicy({ id: 'restricted', name: 'Restricted', action: 'block', destinations: ['example.com'], appliesTo: { groups: ['data'] } })
  const member = { name: 'web', groups: ['frontend', 'data'] }
  const compiled = compileFor(member, [allow, block])
  assert.deepEqual(Object.keys(compiled).sort(), ['egress_restricted', 'egress_shared'])
  assert.ok(compiled.egress_restricted.endpoints.every((e) => e.ports.includes(8443) && e.denyRules.length > 0))
  assert.equal(blockedByPolicy([allow, block], member, ['example.com'], (a, b) => a === b).policy.id, 'restricted')
})
