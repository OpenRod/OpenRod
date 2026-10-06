import test from 'node:test'
import assert from 'node:assert/strict'
import { importSelection, importPercent, importSourceId, DEFAULT_IMPORT_TYPES, activityImportQuery } from './resource-imports.js'

test('selected imports include transitive dependencies once, including cycles', () => {
  const resources = [
    { key: 'template:a', dependencies: ['setup:a', 'group:a'] },
    { key: 'setup:a', dependencies: ['group:a'] },
    { key: 'group:a', dependencies: ['setup:a'] },
  ]
  assert.deepEqual(importSelection(resources, ['template:a']), ['template:a', 'setup:a', 'group:a'])
  assert.throws(() => importSelection(resources, ['missing']), /Missing import dependency/)
})
test('same gateway context on cloud and local remains distinct', () => {
  assert.notEqual(importSourceId({ target: 'cloud', context: 'same' }), importSourceId({ target: 'local', context: 'same' }))
})
test('group selection includes required source restrictions and their dependencies', () => {
  const resources = [
    { key: 'groups:engineering', dependencies: [] },
    { key: 'groups:other', dependencies: [] },
    { key: 'network:source-block', dependencies: ['groups:engineering'], requiredForGroups: ['engineering'] },
    { key: 'network:unrelated-block', dependencies: ['groups:other'], requiredForGroups: ['other'] },
  ]
  assert.deepEqual(importSelection(resources, ['groups:engineering']), ['groups:engineering', 'network:source-block'])
  assert.deepEqual(importSelection(resources, ['network:source-block']), ['network:source-block', 'groups:engineering'])
})
test('failed and skipped items count toward settled progress, never successful progress', () => {
  assert.equal(importPercent({ items: [{ status: 'completed' }, { status: 'failed' }, { status: 'running' }] }), 67)
  assert.equal(importPercent({ items: [] }), 0)
})
test('activity remains opt-in and bounded history requests preserve their snapshot', () => {
  assert.equal(DEFAULT_IMPORT_TYPES.includes('activity'), false)
  assert.deepEqual(activityImportQuery(), { offset: 0 })
  assert.deepEqual(activityImportQuery({ from: '2026-10-01T12:00:00Z', to: '2026-10-02T12:00:00Z', offset: 500, snapshot: 123 }), { from: '2026-10-01T12:00:00.000Z', to: '2026-10-02T12:00:00.000Z', offset: 500, snapshot: 123 })
  assert.throws(() => activityImportQuery({ from: 'bad' }), /valid activity date/)
  assert.throws(() => activityImportQuery({ from: '2026-10-03T00:00:00Z', to: '2026-10-01T00:00:00Z' }), /start must be before/)
})

test('selection categories keep mixed setups and dependency resources exactly once', async () => {
  const { groupImportResources } = await import('./resource-imports.js')
  const resources = [
    { key: 'mcp', type: 'setups', data: {items:[{kind:'mcp'}]} },
    { key: 'skill', type: 'setups', data: {items:[{kind:'skill'}]} },
    { key: 'mixed', type: 'setups', data: {items:[{kind:'mcp'},{kind:'skill'}]} },
    { key: 'empty', type: 'setups' }, { key: 'policy', type: 'policyTemplates' },
    { key: 'network', type: 'network' }, { key: 'group', type: 'groups' }, { key: 'future', type: 'future' },
  ]
  const grouped = groupImportResources(resources)
  assert.deepEqual(grouped.map(section => section.id), ['groups', 'network', 'setups', 'policyTemplates', 'other'])
  assert.deepEqual(grouped.find(section => section.id === 'setups').groups.map(group => [group.id, group.items.map(item => item.key)]), [['mcps',['mcp']],['skills',['skill']],['mixed',['mixed']],['saved',['empty']]])
  assert.deepEqual(grouped.flatMap(section => section.items).map(item => item.key).sort(), resources.map(item => item.key).sort())
  assert.deepEqual(groupImportResources([]), [])
})
