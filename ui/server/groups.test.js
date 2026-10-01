import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { GROUP_LABEL, groupsOf, assignGroup, readMembers, readOrg } from './org.js'
import { appliesTo, compileFor, validatePolicy, writePolicy, listPolicies } from './egress.js'
import { runWithContext } from './gateway.js'

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
  const inGroup = { name: 'web', groups: groupsOf(sandbox('web'), members, groups) }
  const outside = { name: 'etl', groups: groupsOf(sandbox('etl'), members, groups) }
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

test('memberships and imported network rules stay in their gateway and workspace', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openshell-groups-scope-'))
  const previous = process.env.OPENSHELL_CONSOLE_DATA_DIR
  process.env.OPENSHELL_CONSOLE_DATA_DIR = root
  t.after(async () => {
    if (previous === undefined) delete process.env.OPENSHELL_CONSOLE_DATA_DIR
    else process.env.OPENSHELL_CONSOLE_DATA_DIR = previous
    await fs.rm(root, { recursive: true, force: true })
  })
  const contexts = [
    { gateway: 'test-one', workspace: 'alpha' },
    { gateway: 'test-one', workspace: 'beta' },
    { gateway: 'test-two', workspace: 'alpha' },
  ]
  const policy = validatePolicy({ id: 'registry', name: 'Registry', action: 'allow', destinations: ['registry.npmjs.org'], appliesTo: { sandboxes: ['same-name'] } })
  await runWithContext(contexts[0], async () => {
    await assignGroup(['same-name'], 'frontend')
    await writePolicy(policy)
  })
  await runWithContext(contexts[1], () => assignGroup(['same-name'], 'data'))
  await Promise.all(contexts.map((context, index) => runWithContext(context, async () => {
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(await readMembers(), index === 0 ? { 'same-name': ['frontend'] } : index === 1 ? { 'same-name': ['data'] } : {})
    assert.deepEqual(await listPolicies(), index === 0 ? [policy] : [])
    assert.deepEqual(await readOrg(), { blocked: [], outside: 'block' })
  })))
  await runWithContext(contexts[1], () => assignGroup(['same-name'], null, { forget: true }))
  await runWithContext(contexts[0], async () => assert.deepEqual(await readMembers(), { 'same-name': ['frontend'] }))
})
