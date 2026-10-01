import test from 'node:test'
import assert from 'node:assert/strict'
import { importSetup } from './import-setup.js'

const review = { token: 'original', items: [] }
const ready = { token: 'prepared', items: [{ name: 'tool', issues: [] }] }
function fixture(final = { status: 'complete', review: ready }) {
  const calls = []
  const api = {
    prepareSetup: async (...args) => { calls.push(['prepare', ...args]); return { id: 'job', status: 'running' } },
    setupPreparation: async id => { calls.push(['poll', id]); return { id, ...final } },
    saveSetup: async (...args) => { calls.push(['save', ...args]); return { id: 'saved' } },
  }
  return { api, calls }
}
const options = { wait: async () => {} }
test('one Import prepares, checks and saves the prepared snapshot automatically', async () => {
  const { api, calls } = fixture()
  const updates = []
  const result = await importSetup(api, review, 'Tools', {}, { ...options, onProgress: job => updates.push(job.status) })
  assert.equal(result.status, 'saved')
  assert.deepEqual(calls, [['prepare', 'original', {}], ['poll', 'job'], ['save', 'prepared', 'Tools', true]])
  assert.equal(updates[0], 'running')
})
test('credentials or incompatible items stop automatic saving and retain the prepared review', async () => {
  const attention = { ...ready, items: [{ name: 'tool', issues: ['Connect credentials'] }] }
  const { api, calls } = fixture({ status: 'complete', review: attention })
  let retained
  const result = await importSetup(api, review, 'Tools', {}, { ...options, onReview: value => { retained = value } })
  assert.equal(result.status, 'needs-attention')
  assert.equal(retained, attention)
  assert.ok(!calls.some(([action]) => action === 'save'))
})
test('cancelled, failed and interrupted imports never save', async () => {
  for (const status of ['cancelled', 'failed', 'interrupted']) {
    const { api, calls } = fixture({ status, review: ready, message: 'Stopped' })
    const run = () => importSetup(api, review, 'Tools', {}, options)
    if (status === 'cancelled') assert.equal((await run()).status, 'cancelled')
    else await assert.rejects(run, /Stopped/)
    assert.ok(!calls.some(([action]) => action === 'save'))
  }
})
test('cancellation arriving as checks complete prevents automatic saving', async () => {
  const { api, calls } = fixture()
  assert.equal((await importSetup(api, review, 'Tools', {}, { ...options, isCancelled: () => true })).status, 'cancelled')
  assert.ok(!calls.some(([action]) => action === 'save'))
})
test('resume polls the existing job without repeating preparation', async () => {
  const { api, calls } = fixture()
  await importSetup(api, review, 'Tools', {}, { ...options, resumeJob: { id: 'job', status: 'running' } })
  assert.deepEqual(calls.map(([action]) => action), ['poll', 'save'])
})
test('save failures retain the completed review for a save-only retry', async () => {
  const { api } = fixture()
  api.saveSetup = async () => { throw Error('Save failed') }
  let retained
  await assert.rejects(importSetup(api, review, 'Tools', {}, { ...options, onReview: value => { retained = value } }), /Save failed/)
  assert.equal(retained, ready)
})
