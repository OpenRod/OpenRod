import test from 'node:test'
import https from 'node:https'
import { EventEmitter } from 'node:events'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createActivityStore } from './activity-store.js'
import { createActivityDelivery, destinationURL, publicAddress, postEvent } from './activity-delivery.js'
import { toOCSF, exportDocument } from '../src/lib/activity-export.js'
const spec = { name: 'Security', url: 'https://logs.example.com/events', auth: 'bearer', token: 'private-test-token', format: 'ocsf' }
const event = (id, extra = {}) => ({ id, at: '2026-09-29T12:00:00Z', sandbox: 'box', category: 'NET', action: 'OPEN', severity: 'MED', verdict: 'denied', outcome: 'unknown', original: { message: 'denied' }, ...extra })

test('OCSF Base Event preserves evidence and does not turn denial into failure or fabricate source time', () => {
  const source = event('one', { receivedAt: '2026-09-29T12:01:00Z' })
  const ocsf = toOCSF(source)
  assert.equal(ocsf.class_uid, 0); assert.equal(ocsf.category_uid, 0)
  assert.equal(ocsf.type_uid, ocsf.class_uid * 100 + ocsf.activity_id)
  assert.equal(ocsf.metadata.version, '1.4.0'); assert.equal(ocsf.metadata.uid, 'one')
  assert.equal(ocsf.time, Date.parse(source.at)); assert.equal(ocsf.severity_id, 3); assert.equal(ocsf.status_id, 0)
  assert.deepEqual(JSON.parse(ocsf.raw_data), source.original)
  assert.deepEqual(ocsf.unmapped.openshell, source)
  const fallback = toOCSF({ ...source, at: null, severity: 'WARN', outcome: 'failure' })
  assert.equal(fallback.time, Date.parse(source.receivedAt)); assert.match(fallback.unmapped.time_basis, /source timestamp unavailable/)
  assert.equal(fallback.status_id, 2); assert.equal(fallback.severity_id, 0)
  assert.throws(() => toOCSF({}), /timestamp/)
  assert.deepEqual(exportDocument([source], {}, 'ocsf'), [ocsf])
  assert.deepEqual(exportDocument([source], { query: 'denied' }).events, [source])
})
test('destinations reject unsafe endpoints and header injection', () => {
  for (const url of ['http://example.com', 'https://127.0.0.1', 'https://2130706433', 'https://[::ffff:127.0.0.1]', 'https://user:pass@example.com', 'https://example.com?token=secret', 'https://example.com#x', 'https://localhost', 'https://host.local']) assert.throws(() => destinationURL(url))
  for (const ip of ['10.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '100.64.1.1', '::1', 'fc00::1', 'fe80::1', '::ffff:8.8.8.8', '2002:7f00:1::']) assert.equal(publicAddress(ip), false, ip)
  assert.ok(publicAddress('8.8.8.8')); assert.ok(publicAddress('2606:4700:4700::1111'))
  const store = createActivityStore(':memory:'), delivery = createActivityDelivery(':memory:', store)
  try {
    assert.throws(() => delivery.create({ ...spec, token: 'abc\r\nx: injected' }), /token/)
    const d = delivery.create(spec)
    assert.equal(d.enabled, false); assert.equal(d.token, undefined); assert.equal(d.hasToken, true)
    assert.ok(!JSON.stringify(delivery.list()).includes(spec.token))
  } finally { delivery.stop(); store.close() }
})
test('persistent delivery starts after creation, filters events, retries same ID and survives restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-test-'))
  const store = createActivityStore(path.join(dir, 'events.sqlite'))
  let clock = 100000, failing = true
  const sent = []
  const send = async (d, e) => { assert.equal(d.token, spec.token); sent.push(e.id); if (failing) throw new Error('HTTP 503'); return { status: 202 } }
  let delivery = createActivityDelivery(path.join(dir, 'delivery.sqlite'), store, { send, now: () => clock })
  try {
    store.ingest(event('old'))
    const d = delivery.create({ ...spec, filters: { verdicts: ['denied'] } })
    const allowed = store.ingest(event('allowed', { verdict: 'allowed' }))
    const denied = store.ingest(event('denied'))
    await delivery.tick(); assert.equal(sent.length, 0)
    delivery.change(d.id, 'resume'); await delivery.tick()
    assert.deepEqual(sent, [denied.id]); assert.equal(delivery.list()[0].skipped, 1)
    assert.equal(delivery.list()[0].backlog, 1)
    await delivery.tick(); assert.equal(sent.length, 1)
    delivery.stop()
    delivery = createActivityDelivery(path.join(dir, 'delivery.sqlite'), store, { send, now: () => clock })
    clock += 10000; failing = false; await delivery.tick()
    assert.deepEqual(sent, [denied.id, denied.id]); assert.equal(delivery.list()[0].delivered, 1)
    assert.equal(delivery.list()[0].backlog, 0); assert.equal(delivery.list()[0].error, null)
    assert.ok(!sent.includes(allowed.id))
    assert.equal(fs.statSync(path.join(dir, 'delivery.sqlite')).mode & 0o777, 0o600)
    delivery.change(d.id, 'pause'); store.ingest(event('later')); await delivery.tick(); assert.equal(sent.length, 2)
    delivery.change(d.id, 'resume'); await delivery.tick(); assert.equal(sent.length, 3)
  } finally { delivery.stop(); store.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})
test('eight failures pause with evidence retained; retry recovers; tests contain no real logs', async () => {
  const store = createActivityStore(':memory:')
  let clock = 0, failing = true
  const sent = []
  const delivery = createActivityDelivery(':memory:', store, { now: () => clock, send: async (_d, e) => { sent.push(e); if (failing) throw new Error('HTTP 401'); return { status: 204 } } })
  try {
    const d = delivery.create(spec); store.ingest(event('real'))
    delivery.change(d.id, 'resume')
    for (let i = 0; i < 8; i++) { await delivery.tick(); clock += 1000000 }
    assert.equal(delivery.list()[0].enabled, false); assert.equal(delivery.list()[0].backlog, 1)
    failing = false
    const result = await delivery.test(d.id); assert.equal(result.status, 204)
    assert.equal(sent.at(-1).action, 'DESTINATION_TEST'); assert.equal(sent.at(-1).sandbox, 'synthetic-test')
    assert.equal(delivery.list()[0].backlog, 1); assert.equal(delivery.list()[0].delivered, 0)
    delivery.change(d.id, 'retry'); await delivery.tick(); assert.equal(delivery.list()[0].backlog, 0)
    delivery.change(d.id, 'remove'); assert.deepEqual(delivery.list(), [])
    assert.equal(store.query().total, 1)
  } finally { delivery.stop(); store.close() }
})
test('pause during an in-flight delivery does not overwrite paused state or advance cursor', async () => {
  const store = createActivityStore(':memory:')
  let finish
  const delivery = createActivityDelivery(':memory:', store, { send: () => new Promise((resolve) => { finish = resolve }) })
  try {
    const d = delivery.create(spec); store.ingest(event('pending')); delivery.change(d.id, 'resume')
    const running = delivery.tick(); delivery.change(d.id, 'pause'); finish({ status: 200 }); await running
    assert.equal(delivery.list()[0].enabled, false); assert.equal(delivery.list()[0].backlog, 1)
  } finally { delivery.stop(); store.close() }
})


test('HTTPS transport sends authenticated OCSF with stable identity and rejects redirects', async (t) => {
  let status = 202, captured
  t.mock.method(https, 'request', (url, options, callback) => {
    const req = new EventEmitter()
    req.end = (body) => {
      captured = { url, options, body: JSON.parse(body) }
      queueMicrotask(() => { callback({ statusCode: status, destroy() {} }); req.emit('close') })
    }
    req.destroy = () => { req.emit('error', new Error('failure')); req.emit('close') }
    return req
  })
  const d = { ...spec, url: 'https://8.8.8.8/events' }
  const result = await postEvent(d, event('identity'), new AbortController().signal)
  assert.equal(result.status, 202); assert.equal(captured.options.headers.authorization, `Bearer ${spec.token}`)
  assert.equal(captured.options.headers['idempotency-key'], 'identity')
  assert.equal(captured.body.metadata.uid, 'identity'); assert.equal(captured.body.class_uid, 0)
  assert.notEqual(captured.options.rejectUnauthorized, false)
  status = 302
  await assert.rejects(postEvent(d, event('identity')), /HTTP 302/)
  await assert.rejects(postEvent({ ...d, url: 'https://127.0.0.1/events' }, event('identity')), /public HTTPS/)
})

test('OCSF export does not promote a log level to security severity', () => {
  const log = event('ordinary-log', { severity: undefined, level: 'INFO' })
  assert.equal(toOCSF(log).severity_id, 0)
  assert.equal(toOCSF(log).unmapped.openshell.level, 'INFO')
})
