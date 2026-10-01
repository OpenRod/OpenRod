import https from 'node:https'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { publicAddress } from './activity-delivery.js'
import { fail } from './setup-discovery.js'
import { readOrg, blockedBy } from './org.js'
import { listPolicies, blockedByPolicy } from './egress.js'
import { hostMatches } from '../src/lib/egress.js'

// Read-only OAuth metadata discovery runs in the trusted control plane. Pin every
// socket to checked public DNS answers; never follow redirects or proxy env vars.
export function publicHTTPS(value) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port && url.port !== '443' || url.hostname.endsWith('.local') || url.hostname.endsWith('.localhost')) throw fail('Sign-in requires a public HTTPS service on port 443.')
  return url
}
export async function oauthFetch(input, init = {}, approvedHosts = new Set(), pendingHosts = new Set()) {
  const url = publicHTTPS(typeof input === 'string' || input instanceof URL ? input : input.url)
  if (!approvedHosts.has(url.hostname)) { pendingHosts.add(url.hostname); throw fail('Review the additional sign-in destination.', 409) }
  const [org, policies] = await Promise.all([readOrg(), listPolicies()])
  if (blockedBy(org, [url.hostname]) || blockedByPolicy(policies, { name: '', group: null }, [url.hostname], hostMatches)) throw fail('Sign-in destination is blocked by organization policy.', 403)
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true })
  if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw fail('Sign-in destination resolves to a private or reserved address.')
  const chosen = addresses[0]
  const method = init.method || input.method || 'GET'
  if (method !== 'GET') throw fail('Sign-in discovery only permits metadata reads.')
  const headers = Object.fromEntries(new Headers(init.headers || input.headers))
  delete headers.host
  const body = init.body === undefined ? (input instanceof Request && !['GET', 'HEAD'].includes(method) ? await input.text() : undefined) : String(init.body)
  if (body && Buffer.byteLength(body) > 128 * 1024) throw fail('Sign-in request is too large.')
  return new Promise((resolve, reject) => {
    const request = https.request(url, { method, headers, agent: false, signal: AbortSignal.timeout(15000), lookup: (_, options, cb) => options.all ? cb(null, [chosen]) : cb(null, chosen.address, chosen.family) }, response => {
      const chunks = []; let size = 0
      response.on('data', chunk => { size += chunk.length; if (size > 1024 * 1024) request.destroy(); else chunks.push(chunk) })
      response.on('end', () => {
        const status = response.statusCode
        const value = new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers: response.headers })
        Object.defineProperty(value, 'url', { value: url.href })
        resolve(value)
      })
      response.on('error', () => reject(fail('Sign-in HTTPS response failed.')))
    })
    request.on('error', () => reject(fail('Sign-in HTTPS request failed. Check access and retry.')))
    request.end(body)
  })
}
