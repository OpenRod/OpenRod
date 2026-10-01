export const importNeedsAttention = review => review.items.some(item => !item.disabled && item.issues.length > 0)

// Import owns preparation and saving so a successful check never needs another
// confirmation. Keep the prepared review available for corrections or retries.
export async function importSetup(api, review, name, choices, {
  onProgress = () => {}, onReview = () => {}, isCancelled = () => false,
  resumeJob,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  let job = resumeJob || await api.prepareSetup(review.token, choices)
  onProgress(job)
  while (job.status === 'running') {
    await wait(1500)
    job = await api.setupPreparation(job.id)
    onProgress(job)
  }
  if (job.review) onReview(job.review)
  if (job.status === 'cancelled' || isCancelled()) return { status: 'cancelled', review: job.review }
  if (job.status !== 'complete' || !job.review) throw new Error(job.message || 'Import could not finish. Try again.')
  if (importNeedsAttention(job.review)) return { status: 'needs-attention', review: job.review }
  onProgress({ ...job, message: 'Saving your setup…' })
  const setup = await api.saveSetup(job.review.token, name, true)
  return { status: 'saved', setup }
}
