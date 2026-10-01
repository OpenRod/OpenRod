export const CLOUD_ORIGIN = 'https://cloud.example.com'

export function cloudHandoffUrl(origin, nonce) {
  const encoded = btoa(JSON.stringify({ origin, nonce })).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
  return `${CLOUD_ORIGIN}/?handoff=1#handoff=${encoded}`
}

export function isCloudReadyMessage(event, popup, nonce) {
  return Boolean(popup && event.source === popup && event.origin === CLOUD_ORIGIN
    && event.data?.type === 'openrod-cloud-ready' && event.data.nonce === nonce
    && typeof event.data.ticket === 'string' && /^openrod-user-[a-f0-9]{24}\.[a-f0-9]{64}$/.test(event.data.ticket))
}

export const LOCAL_ORIGIN = 'http://127.0.0.1:4600'
export const localHandoffUrl = (nonce) => `${LOCAL_ORIGIN}/?handoff=cloud&target=local#cloud-return=${encodeURIComponent(nonce)}`

export function isLocalHandoffMessage(event, popup, nonce, type) {
  return Boolean(popup && event.source === popup && event.origin === LOCAL_ORIGIN
    && event.data?.type === type && event.data.nonce === nonce)
}
