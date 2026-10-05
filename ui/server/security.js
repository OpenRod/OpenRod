import { verifyWorkerRequest } from './worker-auth.js'
import { isIP } from 'node:net'
import {createHash} from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
export function requestPath(req) {
  if (typeof req.url !== 'string' || !req.url.startsWith('/') || req.url.startsWith('//') || req.url.includes('\\')) throw fail('Invalid request target', 400)
  try { return new URL(req.url, 'http://local').pathname } catch { throw fail('Invalid request target', 400) }
}
export const identityContext = new AsyncLocalStorage()
const fail = (message, status) => Object.assign(new Error(message), { status })
export function isLocalApiRequest(req) {
  const { host = '', origin, 'sec-fetch-site': site } = req.headers
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress)
    && /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)
    && (origin === undefined || origin === `http://${host}`)
    && (site === undefined || site === 'same-origin' || site === 'none')
}
export function cloudConfig(env = process.env) {
  const mode = env.OPENROD_MODE ?? 'local'
  if (!['local', 'cloud', 'worker'].includes(mode)) throw Error('OPENROD_MODE must be local, cloud or worker')
  if (mode === 'local') return { mode }
  if (mode === 'worker') {
    if (!/^[a-f0-9]{64}$/.test(env.OPENROD_WORKER_KEY ?? '') || !env.OPENROD_WORKER_UID || !env.OPENROD_PUBLIC_ORIGIN) throw Error('Worker mode requires its owner, key and public origin')
    const origin = new URL(env.OPENROD_PUBLIC_ORIGIN)
    if (origin.protocol !== 'https:' || origin.origin !== env.OPENROD_PUBLIC_ORIGIN) throw Error('Invalid worker public origin')
    return {mode, key: env.OPENROD_WORKER_KEY, owner: env.OPENROD_WORKER_UID, origin: origin.origin, host: origin.host}
  }
  for (const key of ['OPENROD_ORG_ID', 'OPENROD_PUBLIC_ORIGIN', 'GOOGLE_CLOUD_PROJECT', 'OPENROD_FIREBASE_API_KEY', 'OPENROD_FIREBASE_AUTH_DOMAIN']) if (!env[key]?.trim()) throw Error(`Cloud mode requires ${key}`)
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(env.OPENROD_ORG_ID)) throw Error('Invalid OPENROD_ORG_ID')
  if (!/^[a-z0-9.-]+$/i.test(env.OPENROD_FIREBASE_AUTH_DOMAIN) || !/^[a-z][a-z0-9-]{4,62}$/.test(env.GOOGLE_CLOUD_PROJECT)) throw Error('Invalid Identity Platform project or auth domain')
  const origin = new URL(env.OPENROD_PUBLIC_ORIGIN)
  if (origin.protocol !== 'https:' || origin.origin !== env.OPENROD_PUBLIC_ORIGIN || origin.username || origin.password) throw Error('OPENROD_PUBLIC_ORIGIN must be an HTTPS origin without a path')
  if (env.FIREBASE_AUTH_EMULATOR_HOST) throw Error('Cloud mode cannot use the authentication emulator')
  return { mode, org: env.OPENROD_ORG_ID, origin: origin.origin, host: origin.host, firebase: { apiKey: env.OPENROD_FIREBASE_API_KEY, authDomain: env.OPENROD_FIREBASE_AUTH_DOMAIN, projectId: env.GOOGLE_CLOUD_PROJECT } }
}
export const CLOUD_UNRELEASED = 'OpenRod cloud and worker modes are not part of this release.'
// Cloud and worker modes return with the cloud release; until then only local mode starts.
export function releaseConfig(env = process.env) {
  if (['cloud', 'worker'].includes(env.OPENROD_MODE)) throw Error(CLOUD_UNRELEASED)
  return cloudConfig(env)
}
const COOKIE = '__Host-openrod_session'
const cookieOf = req => (req.headers.cookie ?? '').split(';').map(s => s.trim()).find(s => s.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1)
export function createSecurity(config, auth, revocations = { has: () => false, add: () => { throw Error("Session revocation store is required") } }) {
  const verified = new WeakMap()
  const attempts = new Map()
  const originFor = req => config.mode !== 'local' ? config.origin : `http://${req.headers.host}`
  const checkBoundary = req => {
    if (config.mode === 'local') { if (!isLocalApiRequest(req)) throw fail('Request rejected', 403); return }
    const { host, origin, 'sec-fetch-site': site } = req.headers
    if (host !== config.host || (req.headers.upgrade?.toLowerCase() === 'websocket' && origin !== config.origin) || (origin !== undefined && origin !== config.origin) || (site && !['same-origin', 'none'].includes(site)) || (req.method !== 'GET' && origin !== config.origin)) throw fail('Request rejected', 403)
  }
  const member = async decoded => {
    const user = await auth.getUser(decoded.uid)
    const claims = user.customClaims ?? {}
    if (user.disabled || !user.emailVerified || !user.providerData?.some(p => p.providerId === 'google.com')) throw fail('Sign in with a verified Google account. Disabled accounts cannot access OpenRod Cloud.', 403)
    return { uid: user.uid, email: user.email, org: config.org, role: claims.openrod_org === config.org && claims.openrod_role === 'admin' ? 'admin' : 'member', expires: decoded.exp * 1000 }
  }
  const authenticate = async req => {
    checkBoundary(req)
    if (config.mode === 'local') return null
    if (config.mode === 'worker') {
      const identity = verifyWorkerRequest(config.key, config.owner, req)
      verified.set(req, identity)
      return identity
    }
    const cookie = cookieOf(req)
    if (!cookie || cookie.length > 10000 || revocations.has(cookie)) throw fail('Sign in to OpenRod Cloud', 401)
    let decoded
    try { decoded = await auth.verifySessionCookie(cookie, true) } catch { throw fail('Session expired. Sign in again.', 401) }
    const identity = await member(decoded)
    if (!Number.isFinite(identity.expires) || identity.expires <= Date.now()) throw fail('Session expired', 401)
    verified.set(req, identity)
    return identity
  }
  const isAllowed = req => config.mode === 'local' ? isLocalApiRequest(req) : verified.has(req)
  const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)) }
  const setCookie = (res, value, age) => res.setHeader('Set-Cookie', `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${age}`)
  const middleware = async (req, res, next) => {
    try {
      const pathname = requestPath(req)
      if (!pathname.startsWith('/api/')) return next()
      checkBoundary(req)
      if (pathname === '/api/auth/config' && req.method === 'GET') return json(res, 200, { mode: config.mode,
        telemetryEnabled: config.mode === 'local' && !['0', 'false'].includes((process.env.OPENROD_TELEMETRY ?? '').toLowerCase()),
        ...(config.mode === 'cloud' ? { firebase: config.firebase } : {}) })
      if (config.mode === 'cloud' && pathname === '/api/auth/session' && req.method === 'POST') {
        if (req.headers['x-openshell-console'] !== '1' || req.headers['content-type'] !== 'application/json') throw fail('Request rejected', 403)
        // nginx overwrites this header from the GCP-appended client address.
        // Trust it only from our loopback proxy, never from an external socket.
        const forwarded = req.headers['x-openrod-client-ip']
        const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
        const key = loopback && typeof forwarded === 'string' && isIP(forwarded) ? forwarded : req.socket.remoteAddress
        const now = Date.now()
        if (attempts.size > 10000) for (const [ip, values] of attempts) if (!values.some(at => now-at < 60000)) attempts.delete(ip)
        if (attempts.size > 20000 && !attempts.has(key)) throw fail('Too many sign-in attempts. Try again shortly.', 429)
        const recent = (attempts.get(key) ?? []).filter(at => now-at < 60000)
        if (recent.length >= 30) throw fail('Too many sign-in attempts. Try again shortly.', 429)
        attempts.set(key, [...recent, now])
        let raw = ''
        for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 16000) throw fail('Request too large', 413) }
        let token
        try { token = JSON.parse(raw).idToken } catch { throw fail('Invalid request', 400) }
        if (typeof token !== 'string') throw fail('Invalid request', 400)
        let decoded
        try { decoded = await auth.verifyIdToken(token, true) } catch { throw fail('Sign-in failed', 401) }
        if (!Number.isFinite(decoded.auth_time) || now/1000-decoded.auth_time > 300 || decoded.auth_time > now/1000+30) throw fail('Please sign in again', 401)
        if (decoded.firebase?.sign_in_provider !== 'google.com' || decoded.email_verified !== true) throw fail('Use a verified Google account to sign in.', 403)
        const identity = await member(decoded)
        const cookie = await auth.createSessionCookie(token, { expiresIn: 3600000 })
        setCookie(res, cookie, 3600)
        return json(res, 200, { user: identity })
      }
      if (config.mode === 'cloud' && pathname === '/api/auth/logout' && req.method === 'POST') {
        if (req.headers['x-openshell-console'] !== '1') throw fail('Request rejected', 403)
        setCookie(res, '', 0)
        const cookie = cookieOf(req)
        if (cookie) revocations.add(cookie, Date.now() + 3600000)
        return json(res, 200, { ok: true })
      }
      const identity = await authenticate(req)
      if (pathname === '/api/auth/me' && req.method === 'GET') return json(res, 200, { mode: config.mode, user: identity })
      if (config.mode === 'cloud' && pathname.startsWith('/api/cloud/')) return identityContext.run(identity, next)
      if (!pathname.startsWith('/api/os/')) return json(res, 404, { error: 'Not found' })
      if (identity && req.method !== 'GET') console.info(JSON.stringify({ event: 'openrod.request', uid: identity.uid, org: identity.org, method: req.method, path: pathname }))
      if (identity && pathname === '/api/os/stream') watch(req, res, identity)
      identityContext.run(identity, next)
    } catch (error) { json(res, error.status ?? 503, { error: error.status ? error.message : 'Authentication unavailable. Try again shortly.' }) }
  }
  function watch(req, target, identity) {
    const expiry = setTimeout(() => target.destroy(), Math.max(1, identity.expires-Date.now()))
    expiry.unref?.()
    const check = config.mode === 'worker' ? null : setInterval(() => { authenticate(req).catch(() => target.destroy()) }, 60000)
    check?.unref?.()
    target.once('close', () => { clearTimeout(expiry); clearInterval(check) })
  }
  return { config, authenticate, isAllowed, originFor, middleware, watch, sessionHash: req => createHash('sha256').update(cookieOf(req) ?? '').digest('hex'), isSessionRevoked: hash => revocations.hasDigest?.(hash) ?? false }
}
export function assertCloudOperation(parts, input = {}) {
  if (!identityContext.getStore()) return
  if (parts[0] === 'local-folder' || parts[0] === 'editors' || (parts[0] === 'sandboxes' && ['editor', 'terminal'].includes(parts[2])) || (parts[0] === 'sandboxes' && parts.length === 1 && input?.folder)) throw fail('Host-local actions are unavailable in OpenRod Cloud. Use the browser terminal or upload files.', 403)
}
