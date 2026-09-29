import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createActivityStore } from './activity-store.js'
import { logView } from './gateway.js'

function line(message, nanos = 1) { return { level: 'OCSF', message, source: 'sandbox', eventTime: { seconds: 1790683200n, nanos } } }
test('normalization preserves evidence and separates policy from outcome', () => {
  const failure = logView('box', line('NET:FAIL [INFO] 127.0.0.1:8080/tcp'))
  assert.equal(failure.verdict, null)
  assert.equal(failure.outcome, 'failure')
  assert.equal(failure.direction, 'in')
  const denied = logView('box', line('NET:OPEN [MED] DENIED /usr/bin/curl(0) -> host:443 [reason:blocked]'))
  assert.equal(denied.verdict, 'denied')
  assert.equal(denied.outcome, 'unknown')
  const http = logView('box', line('HTTP:POST [INFO] ALLOWED POST https://example.com:8443/path?q=one [policy:test engine:l7]'))
  assert.equal(http.destination, 'https://example.com:8443/path?q=one')
  assert.equal(http.original.message, http.message)
  assert.notEqual(logView('box', line('same', 1)).id, logView('box', line('same', 2)).id)
  assert.equal(logView('box', line('SSH:OPEN [INFO]')).verdict, null)
  assert.equal(logView('box', line('CONFIG:SERVICE_ENDPOINT_CREATED [INFO] Service endpoint exposed box/web -> 127.0.0.1:8080')).verdict, null)
})
test('archive persists, preserves deleted-source events, scopes identity and paginates a fixed snapshot', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-store-'))
  const filename = path.join(dir, 'events.sqlite')
  let store = createActivityStore(filename)
  try {
    const event = logView('removed-box', line('NET:OPEN [INFO] ALLOWED /usr/bin/claude(0) -> host:443'))
    assert.ok(store.ingest(event, 'gateway-a'))
    assert.equal(store.ingest(event, 'gateway-a'), null)
    assert.ok(store.ingest(event, 'gateway-b'))
    const first = store.query({ limit: 1 })
    store.ingest(logView('new-box', line('NET:OPEN [INFO] ALLOWED /usr/bin/curl(0) -> other:443')), 'gateway-a')
    const second = store.query({ limit: 1, snapshot: first.snapshot, offset: first.nextOffset })
    assert.equal(second.total, 2)
    assert.notEqual(first.events[0].id, second.events[0].id)
    store.source('gateway-a', { sandbox: 'removed-box', status: 'inactive' })
    store.close(); store = createActivityStore(filename)
    assert.equal(store.query({ sandboxes: ['removed-box'] }).total, 2)
    assert.equal(store.query({ filters: { process: { mode: 'equals', value: '/usr/bin/curl' } } }).total, 1)
    assert.equal(store.query({ query: 'other:443' }).total, 1)
    assert.equal(store.coverage().complete, false)
    assert.equal(store.coverage().sources[0].status, 'inactive')
    assert.throws(() => store.query({ range: 'custom', from: 'bad' }), /Invalid/)
    assert.throws(() => store.query({ query: {} }), /Invalid/)
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})
test('non-verdict events are searchable and exact pivots do not match adjacent targets', () => {
  const store = createActivityStore(':memory:')
  try {
    store.ingest(logView('box', line('FINDING:DETECTED [HIGH] suspicious process')), 'g')
    store.ingest(logView('box', line('NET:OPEN [INFO] ALLOWED /usr/bin/curl(0) -> foo:443')), 'g')
    store.ingest(logView('box', line('NET:OPEN [INFO] ALLOWED /usr/bin/curl(0) -> foo:4430')), 'g')
    assert.equal(store.query().total, 3)
    assert.equal(store.query({ filters: { severity: { mode: 'equals', value: 'HIGH' } } }).total, 1)
    assert.equal(store.query({ filters: { destination: { mode: 'equals', value: 'foo:443' } } }).total, 1)
    assert.equal(store.query({ verdicts: ['not applicable'] }).total, 1)
  } finally { store.close() }
})
test('cursor identity merges history replay but preserves identical envelopes at distinct source positions', () => {
  const store = createActivityStore(':memory:')
  try {
    const event = logView('box', line('NET:OPEN [INFO] ALLOWED /bin/curl(0) -> host:443'))
    store.ingest(event, 'scope')
    assert.equal(store.ingest({ ...event, sourceCursor: 'cursor-1' }, 'scope'), null)
    assert.equal(store.query().events[0].sourceCursor, 'cursor-1')
    assert.ok(store.ingest({ ...event, sourceCursor: 'cursor-2' }, 'scope'))
    assert.equal(store.ingest({ ...event, sourceCursor: 'cursor-2' }, 'scope'), null)
    assert.equal(store.query().total, 2)
  } finally { store.close() }
})
test('severity ordering is operational priority, not alphabetical order', () => {
  const store = createActivityStore(':memory:')
  try {
    for (const severity of ['INFO', 'HIGH', 'MED', 'CRITICAL']) store.ingest({ sandbox: 'box', id: severity, severity }, 'scope')
    assert.deepEqual(store.query({ sort: { key: 'severity', direction: 'desc' } }).events.map((e) => e.severity), ['CRITICAL', 'HIGH', 'MED', 'INFO'])
  } finally { store.close() }
})

test('archive queries separate log level from security severity', () => {
  const store = createActivityStore(':memory:')
  try {
    store.ingest({ id: 'log', sandbox: 'box', level: 'INFO' })
    store.ingest({ id: 'audit', sandbox: 'box', level: 'OCSF', severity: 'INFO' })
    assert.deepEqual(store.query({ filters: { severity: { mode: 'equals', value: 'INFO' } } }).events.map((e) => e.id).length, 1)
    const logs = store.query({ filters: { logLevel: { mode: 'equals', value: 'INFO' } } }).events
    assert.equal(logs.length, 1)
    assert.equal(logs[0].level, 'INFO')
    assert.equal(logs[0].severity, undefined)
  } finally { store.close() }
})
