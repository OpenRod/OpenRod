import test from 'node:test'
import assert from 'node:assert/strict'
import { activityRow, filterActivity } from './activity-inventory.js'
const now = Date.parse('2026-09-29T12:00:00Z')
const rows = [
  { sandbox: 'box-2', at: '2026-09-29T11:55:00Z', kind: 'audit', verdict: 'denied', destination: 'blocked.example:443', binary: '/usr/bin/curl', reason: 'policy_dns_ineligible', message: 'a' },
  { sandbox: 'box-10', at: '2026-09-29T10:00:00Z', kind: 'audit', verdict: 'allowed', detail: 'fallback.example', category: 'HTTP', method: 'GET', policy: '_provider_example', message: 'b' },
  { sandbox: 'box-2', at: '2026-09-29T11:59:00Z', kind: 'inbound', verdict: 'allowed', destination: '/api', message: 'c' },
].map(activityRow)
test('combines sandbox, verdict, rendered reason, exclusion, search and time filters', () => {
  assert.deepEqual(filterActivity(rows, { now, range: '15', sandboxes: ['box-2', 'box-10'], verdicts: ['denied'], query: '/usr/bin', filters: { why: { mode: 'contains', value: 'NO RULE' }, destination: { mode: 'excludes', value: 'fallback' } } }).map((r) => r.key), [rows[0].key])
  assert.equal(filterActivity(rows, { filters: { action: { mode: 'contains', value: 'GET' } } })[0], rows[1])
  assert.equal(filterActivity(rows, { filters: { why: { mode: 'contains', value: 'provider · example' } } })[0], rows[1])
})
test('isolates inbound and respects inclusive custom bounds', () => {
  assert.deepEqual(filterActivity(rows, { direction: 'in', range: 'custom', from: '2026-09-29T11:59:00Z', to: '2026-09-29T11:59:00Z' }), [rows[2]])
  assert.equal(filterActivity(rows, { range: 'custom', from: '2026-09-30T00:00:00Z' }).length, 0)
})
test('sorts all seven columns in both directions without mutating input', () => {
  for (const key of ['time', 'verdict', 'sandbox', 'agent', 'action', 'destination', 'why']) {
    const asc = filterActivity(rows, { sort: { key, direction: 'asc' } })
    const desc = filterActivity(rows, { sort: { key, direction: 'desc' } })
    assert.deepEqual(asc.map((r) => r.values[key]), desc.map((r) => r.values[key]).reverse())
  }
  assert.equal(rows[0].values.sandbox, 'box-2')
  assert.equal(filterActivity(rows, { sort: { key: 'sandbox', direction: 'asc' } })[0].values.sandbox, 'box-2')
})
test('filters 10,000 distinct sandboxes and rejects missing timestamps in timed views', () => {
  const fleet = Array.from({ length: 10000 }, (_, i) => activityRow({ ...rows[0].event, sandbox: `sandbox-${i}`, message: `${i}` }))
  assert.equal(filterActivity(fleet, { sandboxes: ['sandbox-9999'] })[0].values.sandbox, 'sandbox-9999')
  assert.equal(filterActivity(fleet, { sort: { key: 'sandbox', direction: 'desc' } })[0].values.sandbox, 'sandbox-9999')
  assert.equal(filterActivity([activityRow({ kind: 'audit', verdict: 'allowed' })], { range: '15', now }).length, 0)
})

test('keeps agent identity separate from the combined action', () => {
  const claude = activityRow({ ...rows[0].event, binary: '/usr/local/bin/claude', method: 'POST' })
  const codex = activityRow({ ...rows[0].event, binary: '/usr/local/bin/codex' })
  assert.equal(claude.values.agent, 'Claude Code')
  assert.equal(claude.agent.logo, '/logos/agents/claudecode.svg')
  assert.equal(claude.values.action, 'POST')
  assert.equal(codex.values.agent, 'Codex')
  assert.equal(codex.agent.logo, '/logos/agents/codex.svg')
  assert.equal(rows[0].values.action, 'curl')
  assert.equal(rows[0].values.agent, '')
  assert.equal(rows[1].values.action, 'GET')
  const curlGet = activityRow({ ...rows[0].event, method: 'GET' })
  assert.equal(curlGet.values.action, 'curl · GET')
  assert.equal(codex.values.action, '')
  assert.deepEqual(filterActivity([curlGet], { filters: { action: { mode: 'contains', value: 'curl · GET' } } }), [curlGet])
  assert.equal(activityRow({ binary: '/usr/bin/agent' }).agent, null)
  assert.deepEqual(filterActivity([claude, codex], { filters: { agent: { mode: 'contains', value: 'Claude' }, action: { mode: 'contains', value: 'POST' } } }), [claude])
  assert.deepEqual(filterActivity([claude, codex], { query: 'Claude Code' }), [claude])
})
