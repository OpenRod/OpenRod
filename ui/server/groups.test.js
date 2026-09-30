import test from 'node:test'
import assert from 'node:assert/strict'
import { GROUP_LABEL, groupOf } from './org.js'
import { appliesTo, compileFor, validatePolicy } from './egress.js'

const groups = [{ id: 'frontend' }, { id: 'data' }]
const sandbox = (name, label) => ({ name, labels: label ? { [GROUP_LABEL]: label } : {} })

test('a stored membership decides the group', () => {
  assert.equal(groupOf(sandbox('web'), { web: 'frontend' }, groups), 'frontend')
})

test('a stored membership overrides the creation label, including "no group"', () => {
  assert.equal(groupOf(sandbox('web', 'frontend'), { web: 'data' }, groups), 'data')
  assert.equal(groupOf(sandbox('web', 'frontend'), { web: null }, groups), null)
})

test('without a stored membership the creation label still counts', () => {
  assert.equal(groupOf(sandbox('web', 'frontend'), {}, groups), 'frontend')
})

test('a group that no longer exists counts as none', () => {
  assert.equal(groupOf(sandbox('web'), { web: 'gone' }, groups), null)
  assert.equal(groupOf(sandbox('web', 'gone'), {}, groups), null)
})

test('a policy aimed at a group reaches its members and nobody else', () => {
  const policy = validatePolicy({ id: 'npm', name: 'npm', action: 'allow', destinations: ['registry.npmjs.org'], appliesTo: { groups: ['frontend'] } })
  const members = { web: 'frontend', etl: 'data' }
  const inGroup = { name: 'web', group: groupOf(sandbox('web'), members, groups) }
  const outside = { name: 'etl', group: groupOf(sandbox('etl'), members, groups) }
  assert.ok(appliesTo(policy, inGroup))
  assert.ok(!appliesTo(policy, outside))
  assert.ok(compileFor(inGroup, [policy]).egress_npm)
  assert.equal(compileFor(outside, [policy]).egress_npm, undefined)
})
