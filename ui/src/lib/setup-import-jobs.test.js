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
  assert.throws(() => store.updateReview(first.id, prepared, true), /Wait for the import/)
  finish({ status: 'cancelled' })
  await first.promise
})

test('removing an import item survives reopening and saves the updated review', async () => {
  const updated = { token: 'without-failed-item', items: [{ id: 'working' }] }
  const store = createSetupImportJobs({ saveSetup: async token => {
    assert.equal(token, updated.token)
    return { id: 'saved' }
  } }, async (_, r, name, choices, callbacks) => {
    callbacks.onReview(prepared)
    return { status: 'needs-attention', review: prepared }
  })
  const task = store.start({ review, name: 'Tools' })
  await task.promise
  store.updateReview(task.id, updated, true)
  const reopened = store.getSnapshot()[0]
  assert.deepEqual(reopened.review, updated)
  assert.equal(reopened.preparation, null)
  assert.equal(reopened.prepared, true)
  await store.start({ id: reopened.id, review: reopened.review, name: reopened.name, saveOnly: reopened.prepared }).promise
  assert.equal(store.getSnapshot()[0].status, 'saved')
})
test('notification messages list inactive items and point attention back to the import', async () => {
  const saved = createSetupImportJobs({}, async () => ({ status: 'saved', setup: { id: 'saved' }, inactive: ['shadcn', 'local'] }))
  await saved.start({ review, name: 'Tools' }).promise
  assert.equal(saved.getSnapshot()[0].message, 'Available in templates and sandboxes. Inactive: shadcn, local.')
  const clean = createSetupImportJobs({}, async () => ({ status: 'saved', setup: { id: 'saved' }, inactive: [] }))
  await clean.start({ review, name: 'Tools' }).promise
  assert.equal(clean.getSnapshot()[0].message, 'Available in templates and sandboxes.')
  const attention = createSetupImportJobs({}, async () => ({ status: 'needs-attention', review: prepared }))
  await attention.start({ review, name: 'Tools' }).promise
  assert.equal(attention.getSnapshot()[0].message, 'Some items need attention. Open the import to remove or fix them.')
  const saveOnly = createSetupImportJobs({ saveSetup: async () => ({ id: 'saved' }) })
  await saveOnly.start({ review: { token: 'prepared', items: [{ name: 'shadcn', issues: ['Unsupported'] }, { name: 'ok', issues: [] }] }, name: 'Tools', saveOnly: true }).promise
  assert.equal(saveOnly.getSnapshot()[0].message, 'Available in templates and sandboxes. Inactive: shadcn.')
})
test('saved jobs keep the egress policy the save created, for the network access popup', async () => {
  const egressPolicy = { id: 'setup-saved', name: 'MCPs & Skills: Tools', created: true, destinations: ['api.github.com'], hosts: [{ host: 'api.github.com', items: ['GitHub'] }], blocked: [], sync: { applied: [], failed: [] } }
  const imported = createSetupImportJobs({}, async () => ({ status: 'saved', setup: { id: 'saved', egressPolicy } }))
  await imported.start({ review, name: 'Tools' }).promise
  assert.deepEqual(imported.getSnapshot()[0].setup.egressPolicy, egressPolicy)
  assert.equal(imported.getSnapshot()[0].message, 'Available in templates and sandboxes. Created the egress policy “MCPs & Skills: Tools”.')
  const unsaved = createSetupImportJobs({}, async () => ({ status: 'saved', setup: { id: 'saved', egressPolicy: null, egressPolicyError: 'Too many destinations.' } }))
  await unsaved.start({ review, name: 'Tools' }).promise
  assert.equal(unsaved.getSnapshot()[0].message, 'Available in templates and sandboxes. Its egress policy wasn’t saved.')
  const saveOnly = createSetupImportJobs({ saveSetup: async () => ({ id: 'saved', egressPolicy }) })
  await saveOnly.start({ review: prepared, name: 'Tools', saveOnly: true }).promise
  assert.deepEqual(saveOnly.getSnapshot()[0].setup.egressPolicy, egressPolicy)
})
