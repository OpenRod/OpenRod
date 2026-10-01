import { isPackagePending } from '../../shared/setup-launch.js'

export const importNeedsAttention = review => review.items.some(item => !item.disabled && item.issues.length > 0)
export const providedCredentials = choice => Boolean(choice?.useSourceSecrets || choice?.provider || Object.values(choice?.secrets || {}).some(Boolean))
// Import installs pending packages, retries failed preparation and connects
// provided credentials. Every other issue was visible before Import was pressed.
const expectedIssues = (item, choice) => item.issues.filter(issue => !isPackagePending(issue) && !item.preparationIssues?.includes(issue) && !(issue.startsWith('Connect credentials') && providedCredentials(choice)))
export const knownIssues = (review, choices = {}) => new Map(review.items.map(item => [item.id, new Set(expectedIssues(item, choices[item.id]))]))
export const inactiveItems = (review, choices = {}) => review.items.filter(item => !item.disabled && expectedIssues(item, choices[item.id]).length > 0)
export const newIssues = (known, review) => review.items.some(item => !item.disabled && item.issues.some(issue => !known.get(item.id)?.has(issue)))

// Import owns preparation and saving so a successful check never needs another
// confirmation. Known issues save as inactive items; new ones keep the review open.
export async function importSetup(api, review, name, choices, {
  onProgress = () => {}, onReview = () => {}, isCancelled = () => false,
  resumeJob,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  const known = knownIssues(review, choices)
  let job = resumeJob || await api.prepareSetup(review.token, choices)
  onProgress(job)
  let failures = 0
  while (job.status === 'running') {
    await wait(1500 * Math.min(failures + 1, 4))
    // Polling survives a console restart; the preparation keeps running server-side.
    try { job = await api.setupPreparation(job.id); failures = 0 } catch (error) { if (++failures >= 20) throw error; continue }
    onProgress(job)
  }
  if (job.review) onReview(job.review)
  if (job.status === 'cancelled' || isCancelled()) return { status: 'cancelled', review: job.review }
  if (job.status !== 'complete' || !job.review) throw new Error(job.message || 'Import could not finish. Try again.')
  if (newIssues(known, job.review)) return { status: 'needs-attention', review: job.review }
  onProgress({ ...job, message: 'Saving your setup…' })
  const setup = await api.saveSetup(job.review.token, name, true)
  return { status: 'saved', setup, inactive: job.review.items.filter(item => !item.disabled && item.issues.length).map(item => item.name) }
}
