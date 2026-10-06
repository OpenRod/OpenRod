export const IMPORT_TYPES = [
  { id: 'groups', label: 'Groups', description: 'Definitions and policy relationships' },
  { id: 'network', label: 'Network', description: 'Egress rules with destination targets' },
  { id: 'setups', label: 'MCPs & Skills', description: 'Saved setups and skill files' },
  { id: 'templates', label: 'Templates', description: 'Portable image recipes' },
  { id: 'activity', label: 'Activity history', description: 'Historical events, in batches of up to 500', optional: true },
]
export const DEFAULT_IMPORT_TYPES = IMPORT_TYPES.filter(type => !type.optional).map(type => type.id)
export const IMPORT_PAGE_TYPE = { groups: 'groups', egress: 'network', ingress: 'network', setups: 'setups', templates: 'templates', activity: 'activity' }
export const importRunning = job => ['running', 'cancelling'].includes(job?.status)
export const importFinished = job => job && !['planned', 'running', 'cancelling'].includes(job.status)
export function importSelection(resources, selected) {
  const index = new Map(resources.map(item => [item.key, item]))
  const result = new Set()
  function include(key) {
    if (result.has(key)) return
    const item = index.get(key)
    if (!item) throw new Error(`Missing import dependency: ${key}`)
    result.add(key)
    for (const dependency of item.dependencies ?? []) include(dependency)
  }
  selected.forEach(include)
  // Organization restrictions travel with their groups. The backend records
  // these reverse dependencies so a group cannot lose source blocks during a
  // partial selection, even if the Network category was not selected.
  for (let previous = -1; previous !== result.size;) {
    previous = result.size
    for (const item of resources) if (item.requiredForGroups?.some(id => result.has(`groups:${id}`))) include(item.key)
  }
  return [...result]
}
export const importSourceId = location => location?.id ?? JSON.stringify([location?.target, location?.context])
export function activityImportQuery({ from = '', to = '', offset = 0, snapshot } = {}) {
  const query = { offset }
  for (const [key, value] of Object.entries({ from, to })) {
    if (!value) continue
    const date = new Date(value)
    if (!Number.isFinite(date.getTime())) throw new Error('Choose a valid activity date range.')
    query[key] = date.toISOString()
  }
  if (query.from && query.to && query.from > query.to) throw new Error('Activity start must be before its end.')
  if (snapshot != null) query.snapshot = snapshot
  return query
}
export function importPercent(job) {
  if (!job?.items?.length) return 0
  const done = job.items.filter(item => ['created', 'completed', 'reused', 'skipped', 'blocked', 'failed', 'cancelled'].includes(item.status)).length
  return Math.round(done / job.items.length * 100)
}
