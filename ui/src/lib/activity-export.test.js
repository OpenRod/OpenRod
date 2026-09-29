import test from 'node:test'
import assert from 'node:assert/strict'
import { exportDocument } from './activity-export.js'
import { filterActivity, activityRow } from './activity-inventory.js'

const event = { at: '2026-09-29T12:00:00Z', sandbox: 'claude-1', action: 'OPEN', severity: 'HIGH', message: 'private payload', original: { hidden: 'raw payload' } }
test('column selection excludes omitted fields and raw payloads in both formats', () => {
  const context = { columns: ['time', 'sandbox'] }
  const json = exportDocument([event], context)
  assert.deepEqual(json.events, [{ time: event.at, sandbox: event.sandbox }])
  const [ocsf] = exportDocument([event], context, 'ocsf')
  assert.deepEqual(ocsf.unmapped.openshell, json.events[0])
  assert.equal(ocsf.time, Date.parse(event.at))
  assert.equal(ocsf.severity_id, 0)
  assert.equal(ocsf.activity_id, 0)
  assert.equal(ocsf.metadata.version, '1.4.0')
  assert.ok(!JSON.stringify(ocsf).includes('payload'))
  assert.ok(!Object.hasOwn(ocsf, 'activity_name'))
})
test('export time override keeps the other table filters', () => {
  const rows = [event, { ...event, sandbox: 'other' }, { ...event, at: '2026-09-28T12:00:00Z' }].map(activityRow)
  const events = filterActivity(rows, { sandboxes: ['claude-1'], range: 'custom', from: '2026-09-29T00:00:00Z', to: '2026-09-30T00:00:00Z' }).map((row) => row.event)
  assert.deepEqual(exportDocument(events, { columns: ['sandbox'] }).events, [{ sandbox: 'claude-1' }])
})
