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
// A fleet provisioned before OpenRod signs requests with its own header names.
// Its operator supplies their prefix; the source names only OpenRod's headers.
export function legacyHeaderPrefix(value) {
  if (!/^x-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value ?? '') || value === 'x-openrod') throw Error('OPENROD_WORKER_PROTOCOL=legacy requires OPENROD_LEGACY_HEADER_PREFIX, the earlier header prefix such as x-acme')
  return value
}
export function workerProtocol(value = 'current', env = process.env) {
  if (!['current', 'legacy'].includes(value)) throw Error('OPENROD_WORKER_PROTOCOL must be current or legacy')
  if (value === 'legacy') legacyHeaderPrefix(env.OPENROD_LEGACY_HEADER_PREFIX)
  return value
}
export const workerAuthHeader = (protocol, env = process.env) => protocol === 'legacy' ? `${legacyHeaderPrefix(env.OPENROD_LEGACY_HEADER_PREFIX)}-worker-auth` : 'x-openrod-worker-auth'
export const workerNameHeader = (protocol, env = process.env) => protocol === 'legacy' ? `${legacyHeaderPrefix(env.OPENROD_LEGACY_HEADER_PREFIX)}-worker` : 'x-openrod-worker'
export function ownerLabel(value = 'openrod_owner') {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw Error('Invalid OPENROD_WORKER_OWNER_LABEL')
  return value
}
