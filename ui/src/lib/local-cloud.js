import { currentCloudOwner } from './compute-target.js'
import { CLOUD_ORIGIN } from './cloud-origin.js'
export { CLOUD_ORIGIN }
export function isLoopbackOrigin(value) {
  try {
    const url = new URL(value)
    return url.origin === value && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && Boolean(url.port) && Number(url.port) > 0 && !url.username && !url.password
  } catch { return false }
}
export function localConnectFromHash(hash) {
  try {
    const encoded = /^#local-connect=([A-Za-z0-9_-]+)$/.exec(hash)?.[1]
    if (!encoded || encoded.length > 2048) return null
    const value = JSON.parse(atob(encoded.replaceAll('-', '+').replaceAll('_', '/')))
    if (!isLoopbackOrigin(value.origin) || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.nonce ?? '') || !/^[a-f0-9]{64}$/.test(value.challenge ?? '')) return null
    return { origin: value.origin, nonce: value.nonce, challenge: value.challenge }
  } catch { return null }
}
export function isLocalConnectedMessage(event, popup, nonce, cloud = CLOUD_ORIGIN) {
  return Boolean(cloud && popup && event.source === popup && event.origin === cloud && ['openrod-local-connected', 'legacy-local-connected'].includes(event.data?.type) && event.data.nonce === nonce && typeof event.data.code === 'string' && /^[a-f0-9]{64}\.[a-f0-9]{64}$/.test(event.data.code))
}
export async function localCloudRequest(path, body, {signal, owner = currentCloudOwner()} = {}) {
  const response = await fetch(`/api/local-cloud/${path}`, {
    signal,
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(owner ? { 'x-openrod-local-owner': owner } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json', 'x-openshell-console': '1' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const value = await response.json().catch(() => ({}))
  if (value.code === 'CLOUD_OWNER_CHANGED' || (response.status === 401 && ['machine', 'inventory'].includes(path))) window.dispatchEvent(new Event('openrod-session-expired'))
  if (!response.ok) throw Object.assign(new Error(value.error ?? 'Cloud connection unavailable'), {status:response.status})
  return value
}

const pause = (ms, signal) => new Promise((resolve, reject) => {
  const cancel = () => { clearTimeout(timer); reject(new DOMException('Cloud preparation cancelled.', 'AbortError')) }
  const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve() }, ms)
  signal?.addEventListener('abort', cancel, { once: true })
  if (signal?.aborted) cancel()
})
export async function waitForCloudReady(statusRequest, { signal, onProgress = () => {}, wait = pause, attempts = 120 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    signal?.throwIfAborted()
    const value = await statusRequest()
    signal?.throwIfAborted()
    if (!value.connected) throw new Error('Your cloud connection expired. Connect again to continue.')
    if (value.error) throw new Error(value.error)
    onProgress(value)
    if (value.machine?.status === 'ready') return value
    if (value.machine?.status === 'error' || value.machine?.error) throw new Error(value.machine.error ?? 'Your cloud machine could not start.')
    if (attempt < attempts - 1) await wait(5000, signal)
  }
  throw new Error('Your private machine is still preparing. Check its status before trying again.')
}
// Preparation is an explicit mutation. Every request remains bound to the
// account selected before it began, including after an account switch.
export async function prepareCloudMachine({ owner, signal, onProgress, request = localCloudRequest, wait, attempts } = {}) {
  signal?.throwIfAborted()
  const started = await request('machine', {}, { signal, owner })
  let first = true
  return waitForCloudReady(async () => {
    const value = first ? started : await request('machine', undefined, { signal, owner })
    first = false
    if (value.owner !== owner) throw new Error('Your cloud account changed. Choose the destination again.')
    return value
  }, { signal, onProgress, wait, attempts })
}
export async function copyLocalSandbox(local, cloud, name, destinationGroups) {
  const exported = await local.cloudExport(name)
  const result = await cloud.importCloud(destinationGroups ? { ...exported.bundle, destinationGroups } : exported.bundle)
  return { ...result, warning: result.warning || exported.warning }
}
export async function copyCloudSandboxToLocal(cloud, local, name, destinationGroups) {
  if (local.target !== 'local') throw Error('Choose a local destination for this workspace.')
  return copyLocalSandbox(cloud, local, name, destinationGroups)
}

export async function authorizeLocalConnection(handoff, request = fetch) {
  const response = await request('/api/cloud/local-connect/authorize', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-openshell-console': '1' }, body: JSON.stringify(handoff),
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(result.error ?? 'Could not finish sign-in.')
  if (typeof result.code !== 'string' || !/^[a-f0-9]{64}\.[a-f0-9]{64}$/.test(result.code)) throw new Error('Invalid sign-in response.')
  return result
}
export function createLocalSignInAttempt({ popup, origin, cloud = CLOUD_ORIGIN, request = localCloudRequest, events = window, focus = () => window.focus(), setTimer = setInterval, clearTimer = clearInterval, now = Date.now }) {
  let nonce, accepted = false, finished = false, resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  const cancelNonce = async () => {
    if (!nonce) return
    // Cancellation belongs to this attempt, including a response arriving after
    // a newer sign-in. It must never revoke another attempt's connection.
    await request('cancel', { nonce }).catch(() => {})
  }
  const cleanup = () => { clearTimer(timer); events.removeEventListener('message', receive) }
  function cancel(message = 'Cloud sign-in was cancelled.') {
    if (finished) return Promise.resolve()
    finished = true
    cleanup(); popup.close(); reject(new Error(message))
    return cancelNonce()
  }
  const receive = async event => {
    if (finished || accepted || !nonce || !isLocalConnectedMessage(event, popup, nonce, cloud)) return
    accepted = true
    try {
      const value = await request('finish', { nonce, code: event.data.code })
      if (finished) { await cancelNonce(); return }
      if (!value.connected || !value.user) throw new Error('Sign-in did not finish. Try again.')
      finished = true
      cleanup(); popup.close(); focus(); resolve(value)
    } catch (error) {
      if (finished) { await cancelNonce(); return }
      await cancel(error.message)
    }
  }
  const deadline = now() + 15 * 60_000
  const timer = setTimer(() => {
    if (popup.closed || now() > deadline) cancel(popup.closed ? 'Cloud sign-in was cancelled.' : 'Cloud sign-in timed out. Try again.')
  }, 500)
  events.addEventListener('message', receive)
  // The caller owns the attempt before the first asynchronous start request.
  Promise.resolve().then(async () => {
    if (finished) return
    const started = await request('start', { origin })
    nonce = started.nonce
    if (finished) { await cancelNonce(); return }
    popup.location.href = started.url
  }).catch(error => { if (!finished) cancel(error.message) })
  return { promise, cancel }
}
