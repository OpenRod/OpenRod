import { createHash } from 'node:crypto'

// Infrastructure identities can outlive product naming. Configure an existing
// fleet explicitly rather than renaming records or allocating replacement VMs.
export function workerPrefix(value = 'openrod-user') {
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(value)) throw Error('Invalid OPENROD_WORKER_PREFIX')
  return value
}
export function workerOwnerHash(uid) {
  if (typeof uid !== 'string' || !uid || uid.length > 128) throw Object.assign(Error('Invalid account'), { status: 400 })
  return createHash('sha256').update(uid).digest('hex').slice(0, 24)
}
export function workerProtocol(value = 'current') {
  if (!['current', 'legacy'].includes(value)) throw Error('OPENROD_WORKER_PROTOCOL must be current or legacy')
  return value
}
export const workerAuthHeader = protocol => protocol === 'legacy' ? 'x-legacy-worker-auth' : 'x-openrod-worker-auth'
export function ownerLabel(value = 'openrod_owner') {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw Error('Invalid OPENROD_WORKER_OWNER_LABEL')
  return value
}
