import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createActivityStore } from './activity-store.js'
import { createActivityDelivery } from './activity-delivery.js'
const event = (id, extra = {}) => ({ id, sandbox: 'box', at: '2026-09-29T12:00:00Z', category: 'NET', action: 'OPEN', verdict: 'denied', ...extra })

test('selected deletion only removes reviewed IDs and tokens are single-use', () => {
  const store = createActivityStore(':memory:')
  try {
    const a = store.ingest(event('a')), b = store.ingest(event('b'))
    const plan = store.previewDeletion({ mode: 'selected', ids: [a.id, a.id] })
    assert.equal(plan.count, 1); assert.equal(store.query().total, 2)
    assert.throws(() => store.deleteLogs('not-a-plan'), /expired/)
    const result = store.deleteLogs(plan.token)
    assert.equal(result.deleted, 1); assert.equal(result.coverage.deletionRevision, 1)
    assert.deepEqual(store.query().events.map((e) => e.id), [b.id])
    assert.throws(() => store.deleteLogs(plan.token), /expired/)
    assert.equal(store.ingest(event('a')), null)
    assert.throws(() => store.previewDeletion({ mode: 'selected', ids: [] }))
    assert.throws(() => store.previewDeletion({ mode: 'selected', ids: ['bad'] }))
    assert.throws(() => store.previewDeletion({ mode: 'typo' }))
    assert.throws(() => store.previewDeletion({ mode: 'matching' }))
  } finally { store.close() }
})
test('matching deletion spans all pages and uses a frozen snapshot', () => {
  const store = createActivityStore(':memory:')
  try {
    for (let i = 0; i < 620; i++) store.ingest(event(String(i), { sandbox: i < 610 ? 'wanted' : 'other', verdict: i === 0 ? 'allowed' : 'denied' }))
    const plan = store.previewDeletion({ mode: 'matching', query: { sandboxes: ['wanted'], verdicts: ['denied'] } })
    assert.equal(plan.count, 609)
    const fresh = store.ingest(event('fresh', { sandbox: 'wanted' }))
    assert.equal(store.deleteLogs(plan.token).deleted, 609)
    assert.equal(store.query().total, 12); assert.ok(store.has(fresh.id))
    assert.equal(store.query({ verdicts: ['allowed'] }).total, 1)
  } finally { store.close() }
})
test('all deletion ignores filters, keeps future arrivals and source cursors, and never rewinds high-water mark', () => {
  const store = createActivityStore(':memory:')
  try {
    store.ingest(event('one')); store.ingest(event('two', { sandbox: 'other' }))
    store.source('scope', { cursor: 'cursor-99', sandbox: 'box' })
    const high = store.head()
    const plan = store.previewDeletion({ mode: 'all', query: { query: 'no-match' } })
    assert.equal(plan.count, 2); store.deleteLogs(plan.token)
    assert.equal(store.query().total, 0); assert.equal(store.head(), high)
    assert.equal(store.getSource('scope').cursor, 'cursor-99')
    assert.equal(store.countAfter(0), 0)
    const fresh = store.ingest(event('three'))
    assert.ok(store.head() > high); assert.equal(store.after(high)[0].event.id, fresh.id)
    assert.equal(store.deleteLogs(store.previewDeletion({ mode: 'all' }).token).deleted, 1)
    assert.equal(store.deleteLogs(store.previewDeletion({ mode: 'all' }).token).deleted, 0)
  } finally { store.close() }
})
test('deleted identity markers survive restart and block replay while preserving distinct source positions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-delete-')), filename = path.join(dir, 'events.sqlite')
  let store = createActivityStore(filename)
  try {
    const original = event('same')
    store.ingest(original, 'scope')
    store.deleteLogs(store.previewDeletion({ mode: 'all' }).token)
    store.close(); store = createActivityStore(filename)
    assert.equal(store.ingest(original, 'scope'), null)
    assert.equal(store.ingest({ ...original, sourceCursor: 'first' }, 'scope'), null)
    const second = store.ingest({ ...original, sourceCursor: 'second' }, 'scope')
    assert.ok(second)
    store.deleteLogs(store.previewDeletion({ mode: 'all' }).token)
    assert.equal(store.ingest({ ...original, sourceCursor: 'second' }, 'scope'), null)
    assert.ok(store.ingest({ ...original, sourceCursor: 'third' }, 'scope'))
    assert.ok(store.ingest(original, 'different-scope'))
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})
test('deletion review expires without removing evidence', (t) => {
  const store = createActivityStore(':memory:')
  try {
    store.ingest(event('one'))
    const plan = store.previewDeletion({ mode: 'all' })
    t.mock.method(Date, 'now', () => plan.expiresAt + 1)
    assert.throws(() => store.deleteLogs(plan.token), /expired/)
    assert.equal(store.query().total, 1)
  } finally { store.close() }
})
test('deletion cancels cached delivery batches and pending webhook events stay deleted', async () => {
  const store = createActivityStore(':memory:')
  let release
  const sent = []
  const delivery = createActivityDelivery(':memory:', store, { send: async (_d, e) => { sent.push(e.id); return new Promise((resolve) => { release = resolve }) } })
  try {
    const dest = delivery.create({ name: 'Test', url: 'https://example.com/events', auth: 'none', format: 'json' })
    store.ingest(event('one')); store.ingest(event('two'))
    delivery.change(dest.id, 'resume')
    const pending = delivery.tick()
    store.deleteLogs(store.previewDeletion({ mode: 'all' }).token); delivery.logsDeleted()
    release({ status: 200 }); await pending; await delivery.tick()
    assert.equal(sent.length, 1); assert.equal(delivery.list()[0].backlog, 0)
    assert.equal(delivery.list()[0].delivered, 0)
  } finally { delivery.stop(); store.close() }
})
test('deleting a failed event clears its retry state and preserves other events', async () => {
  const store = createActivityStore(':memory:')
  const delivery = createActivityDelivery(':memory:', store, { send: async () => { throw new Error('HTTP 503') } })
  try {
    const dest = delivery.create({ name: 'Test', url: 'https://example.com/events', auth: 'none', format: 'json' })
    const a = store.ingest(event('one')); store.ingest(event('two'))
    delivery.change(dest.id, 'resume'); await delivery.tick()
    assert.equal(delivery.list()[0].attempts, 1)
    store.deleteLogs(store.previewDeletion({ mode: 'selected', ids: [a.id] }).token); delivery.logsDeleted()
    assert.equal(delivery.list()[0].attempts, 0); assert.equal(delivery.list()[0].error, null)
    assert.equal(delivery.list()[0].backlog, 1)
  } finally { delivery.stop(); store.close() }
})
