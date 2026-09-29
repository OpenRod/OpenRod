import test from 'node:test'
import assert from 'node:assert/strict'
import { createActivityStore } from './activity-store.js'
import { createHub } from './api.js'

const delay = (n) => new Promise((r) => setTimeout(r, n))
test('collects without browser clients, exposes history failures and stream interruptions', async () => {
  const store = createActivityStore(':memory:')
  let watchOptions
  const client = { raw: {
    getSandboxLogs: async () => { throw new Error('history unavailable') },
    watchSandbox: async function* (options) {
      watchOptions = options
      yield { payload: { case: 'log', value: { level: 'OCSF', source: 'sandbox', message: 'NET:OPEN [INFO] ALLOWED /bin/curl(0) -> host:443', eventTime: { seconds: 1790683200n, nanos: 1 } } } }
      throw new Error('watch interrupted')
    },
  } }
  const hub = createHub(store, { connect: async () => ({ client, target: { endpoint: 'test' } }), list: async () => [{ id: 'box-id', name: 'box', phase: 'ready' }], interval: 60000 })
  try {
    hub.start()
    await delay(30)
    assert.equal(store.query({ filters: { category: { mode: 'equals', value: 'Network' } } }).total, 1)
    assert.equal(store.query({ filters: { action: { mode: 'equals', value: 'COLLECTION_INTERRUPTED' } } }).total, 1)
    assert.equal(watchOptions.logTailLines, 400)
    const source = store.coverage().sources[0]
    assert.equal(source.status, 'disconnected')
    assert.equal(source.historyError, 'history unavailable')
    assert.equal(source.error, 'watch interrupted')
    assert.equal(source.gapPossible, true)
    assert.ok(source.lastReceivedAt)
  } finally { hub.stop(); await delay(10); store.close() }
})
test('resumes with the saved cursor and records gateway drop warnings', async () => {
  const store = createActivityStore(':memory:')
  store.source('test|box-id|', { sandbox: 'box', cursor: 'cursor-1' })
  let requested
  const hub = createHub(store, {
    connect: async () => ({ target: { endpoint: 'test' }, client: { raw: {
      getSandboxLogs: async () => ({ logs: [] }),
      watchSandbox: async function* (options) {
        requested = options.resumeAfterCursor
        yield { cursor: 'cursor-2', payload: { case: 'log', value: { level: 'INFO', message: 'resumed', eventTime: { seconds: 1790683200n } } } }
        yield { cursor: '', payload: { case: 'warning', value: { message: 'Messages dropped' } } }
      },
    } } }),
    list: async () => [{ id: 'box-id', name: 'box', phase: 'ready' }], interval: 60000,
  })
  try {
    hub.start(); await delay(30)
    assert.equal(requested, 'cursor-1')
    assert.equal(store.coverage().sources[0].cursor, 'cursor-2')
    assert.equal(store.coverage().sources[0].warning, 'Messages dropped')
    assert.equal(store.query({ query: 'Messages dropped' }).total, 1)
  } finally { hub.stop(); await delay(10); store.close() }
})
test('rejected cursors are cleared so the next watch can recover', async () => {
  const store = createActivityStore(':memory:')
  store.source('test|box-id|', { sandbox: 'box', cursor: 'expired-cursor' })
  const hub = createHub(store, {
    connect: async () => ({ target: { endpoint: 'test' }, client: { raw: {
      getSandboxLogs: async () => ({ logs: [] }),
      watchSandbox: async function* () { throw Object.assign(new Error('cursor expired'), { connectCode: 11 }) },
    } } }),
    list: async () => [{ id: 'box-id', name: 'box', phase: 'ready' }], interval: 60000,
  })
  try {
    hub.start(); await delay(30)
    assert.equal(store.coverage().sources[0].cursor, '')
    assert.match(store.coverage().sources[0].warning, /bounded history/)
  } finally { hub.stop(); await delay(10); store.close() }
})
