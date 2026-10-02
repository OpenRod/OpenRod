// Cloud is unavailable unless OPENROD_CLOUD_ORIGIN names an HTTPS origin; local endpoints then refuse before contacting any cloud service.
export const CLOUD_SOON = 'Cloud is coming soon.'
export function cloudOrigin(env = process.env) {
  const value = env.OPENROD_CLOUD_ORIGIN?.trim()
  if (!value) return null
  let url
  try { url = new URL(value) } catch { throw Error('OPENROD_CLOUD_ORIGIN must be an HTTPS origin without a path') }
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password) throw Error('OPENROD_CLOUD_ORIGIN must be an HTTPS origin without a path')
  return value
}
export const cloudUnavailable = () => Object.assign(new Error(CLOUD_SOON), { status: 409 })
