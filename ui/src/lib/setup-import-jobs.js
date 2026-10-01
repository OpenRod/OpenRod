import { importSetup } from './import-setup.js'

const savedPolicy = (setup) => setup?.egressPolicy ? ` ${setup.egressPolicy.created ? 'Created' : 'Updated'} the egress policy “${setup.egressPolicy.name}”.` : setup?.egressPolicyError ? ' Its egress policy wasn’t saved.' : ''

// Owned by the app session, not a dialog or route. Closing either cannot stop
// polling, saving, or delivery of the result. Credentials are not stored here.
export function createSetupImportJobs(api, workflow = importSetup) {
  let snapshot = []
  const listeners = new Set()
  const active = new Map()
  const update = (id, patch) => {
    snapshot = snapshot.map(job => job.id === id ? { ...job, ...patch } : job)
    listeners.forEach(listener => listener())
  }
  return {
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    getSnapshot: () => snapshot,
    updateReview(id, review, prepared) {
      if (active.has(id)) throw new Error('Wait for the import to finish before removing items.')
      update(id, { review, prepared, preparation: null, status: 'needs-attention', message: review.items.length ? 'Import selection updated. Review it to finish importing.' : 'No items remain in this import.' })
    },
    dismiss(id) { snapshot = snapshot.filter(job => job.id !== id); listeners.forEach(listener => listener()) },
    async cancel(id) {
      const run = active.get(id)
      if (!run) return
      run.cancelled = true
      const job = snapshot.find(job => job.id === id)
      if (job?.preparation?.status === 'running') await api.cancelSetupPreparation(job.preparation.id)
    },
    start({ id = crypto.randomUUID(), review, name, choices = {}, resumeJob, saveOnly = false }, callbacks = {}) {
      if (active.has(id)) return { id, promise: active.get(id).promise }
      const run = { cancelled: false }
      active.set(id, run)
      snapshot = [...snapshot.filter(job => job.id !== id), { id, name, review, prepared: saveOnly, status: 'importing', message: saveOnly ? 'Saving your setup…' : 'Preparing your tools…' }]
      listeners.forEach(listener => listener())
      run.promise = (async () => {
        try {
          const result = saveOnly
            ? { status: 'saved', setup: await api.saveSetup(review.token, name, true), inactive: review.items.filter(item => !item.disabled && item.issues?.length).map(item => item.name) }
            : await workflow(api, review, name, choices, {
              resumeJob,
              isCancelled: () => run.cancelled,
              onProgress: preparation => {
                update(id, { preparation, message: preparation.message })
                callbacks.onProgress?.(preparation)
              },
              onReview: next => {
                update(id, { review: next, prepared: true })
                callbacks.onReview?.(next)
              },
            })
          update(id, { status: result.status, setup: result.setup, ...(result.status === 'cancelled' ? { prepared: false } : {}), message: result.status === 'saved' ? `Available in templates and sandboxes.${result.inactive?.length ? ` Inactive: ${result.inactive.join(', ')}.` : ''}${savedPolicy(result.setup)}` : result.status === 'needs-attention' ? 'Some items need attention. Open the import to remove or fix them.' :'Import cancelled. You can resume from the completed preparation.' })
          return result
        } catch (error) {
          update(id, { status: 'failed', message: error.message })
          throw error
        } finally { active.delete(id) }
      })()
      return { id, promise: run.promise }
    },
  }
}
