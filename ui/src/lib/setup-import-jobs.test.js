import test from 'node:test'
import assert from 'node:assert/strict'
import { createSetupImportJobs } from './setup-import-jobs.js'

const review = { token: 'initial', items: [] }
const prepared = { token: 'prepared', items: [] }
test('unsubscribing when a popup closes does not stop saving or lose completion', async () => {
  let finish
  const wait = new Promise(resolve => { finish = resolve })
  const store = createSetupImportJobs({}, async (_, r, name, choices, callbacks) => {
    callbacks.onProgress({ id: 'preparation', status: 'running', message: 'Checking tools' })
    await wait
    callbacks.onReview(prepared)
    return { status: 'saved', setup: { id: 'saved' } }
  })
  let renders = 0
  const unsubscribe = store.subscribe(() => { renders++ })
  const task = store.start({ review, name: 'Tools' })
  assert.equal(store.getSnapshot()[0].status, 'importing')
  unsubscribe()
  const before = renders
  finish()
  await task.promise
  assert.equal(renders, before)
  assert.equal(store.getSnapshot()[0].status, 'saved')
  assert.equal(store.getSnapshot()[0].setup.id, 'saved')
})
test('background errors preserve review and prepared state for a save-only retry', async () => {
  const store = createSetupImportJobs({ saveSetup: async token => { assert.equal(token, 'prepared'); return { id: 'saved' } } }, async (_, r, name, choices, callbacks) => {
    callbacks.onReview(prepared)
    throw Error('Save unavailable')
  })
  const task = store.start({ review, name: 'Tools', choices: { secret: 'not retained' } })
  await assert.rejects(task.promise, /Save unavailable/)
  const job = store.getSnapshot()[0]
  assert.equal(job.status, 'failed')
  assert.equal(job.review.token, 'prepared')
  assert.equal(job.prepared, true)
  assert.ok(!JSON.stringify(job).includes('not retained'))
  await store.start({ id: job.id, review: job.review, name: job.name, saveOnly: true }).promise
  assert.equal(store.getSnapshot().length, 1)
  assert.equal(store.getSnapshot()[0].status, 'saved')
})
test('attention remains available after leaving the page and notifications can be dismissed', async () => {
  const store = createSetupImportJobs({}, async (_, r, name, choices, callbacks) => {
    callbacks.onReview(prepared)
    return { status: 'needs-attention', review: prepared }
  })
  const task = store.start({ review, name: 'Tools' })
  await task.promise
  assert.equal(store.getSnapshot()[0].status, 'needs-attention')
  assert.equal(store.getSnapshot()[0].review, prepared)
  store.dismiss(task.id)
  assert.deepEqual(store.getSnapshot(), [])
})
test('retrying an active job shares the same operation instead of duplicating import', async () => {
  let finish, runs = 0
  const store = createSetupImportJobs({}, async () => { runs++; return new Promise(resolve => { finish = resolve }) })
  const first = store.start({ id: 'same', review, name: 'Tools' })
  const second = store.start({ id: 'same', review, name: 'Tools' })
  assert.equal(first.promise, second.promise)
  assert.equal(runs, 1)
  finish({ status: 'cancelled' })
  await first.promise
})
