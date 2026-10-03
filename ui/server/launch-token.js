// Per-launch secret for the local console, in the style of Jupyter: loopback
// is not a boundary on shared machines or from Docker containers, so every API
// request must also carry a cookie that only the operator's link can set.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { isLocalApiRequest, requestPath } from './security.js'

export const TOKEN_REQUIRED = 'CONSOLE_TOKEN_REQUIRED'
export const createLaunchToken = () => randomBytes(32).toString('base64url')
// Cookies ignore ports, so each console names its own to avoid overwriting another's.
export const tokenCookieName = port => `openrod_token_${port}`
export const tokenCookie = (port, token) => `${tokenCookieName(port)}=${token}`
export const tokenUrl = (host, port, token) => `http://${host.includes(':') ? `[${host}]` : host}:${port}/?token=${token}`
const digest = value => createHash('sha256').update(String(value)).digest()
const isApi = pathname => pathname === '/api' || pathname.startsWith('/api/')

export function createTokenGate(token, { onReuse = () => {} } = {}) {
  if (typeof token !== 'string' || token.length < 32) throw Error('A launch token of at least 32 characters is required')
  const expected = digest(token)
  const valid = value => typeof value === 'string' && value.length <= 256 && timingSafeEqual(digest(value), expected)
  const allowed = req => {
    const prefix = `${tokenCookieName(req.socket?.localPort)}=`
    return (req.headers.cookie ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(prefix)).some(part => valid(part.slice(prefix.length)))
  }
  // A browser OpenRod opens itself gets a one-time code instead of the token:
  // the opener's arguments are visible to other local users, and on Linux a
  // browser it starts keeps them for its whole life. Whoever uses the code
  // first gets the cookie, so a second use is reported: someone else may have
  // been first.
  const codes = new Map(), spent = new Set()
  const launchCode = () => {
    const now = Date.now()
    for (const [code, expires] of codes) if (expires <= now) codes.delete(code)
    const code = createLaunchToken()
    codes.set(code, now + 120_000)
    return code
  }
  const spend = value => {
    if (spent.has(value)) { onReuse(); return false }
    const expires = codes.get(value)
    if (expires === undefined) return false
    codes.delete(value); spent.add(value)
    return expires > Date.now()
  }
  const denied = res => { res.writeHead(401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ error: 'Open the link printed by `openrod` in your terminal.', code: TOKEN_REQUIRED })) }
  // Handlers downstream also read the raw target, so a path the URL parser rewrites (dot segments, %2e) must never reach them.
  const rewritten = (req, pathname) => req.url.split('?', 1)[0] !== pathname
  // Returns true when it answered the request itself.
  const http = (req, res) => {
    let pathname
    try { pathname = requestPath(req) } catch { return false }
    if (rewritten(req, pathname)) { req.resume(); res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ error: 'Invalid request target' })); return true }
    if (isApi(pathname)) { if (allowed(req)) return false; req.resume(); denied(res); return true }
    const url = new URL(req.url, 'http://local')
    if (!url.searchParams.has('token') || !['GET', 'HEAD'].includes(req.method)) return false
    if (!isLocalApiRequest(req)) { res.writeHead(403).end(); return true }
    const supplied = url.searchParams.get('token')
    url.searchParams.delete('token')
    const location = `${url.pathname}${url.search}`
    res.writeHead(302, {
      Location: location.startsWith('//') ? '/' : location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
      ...(valid(supplied) || spend(supplied) ? { 'Set-Cookie': `${tokenCookie(req.socket.localPort, token)}; Path=/; HttpOnly; SameSite=Strict` } : {}),
    }).end()
    return true
  }
  const upgrade = (req, socket) => {
    let pathname
    try { pathname = requestPath(req) } catch { return false }
    const invalid = rewritten(req, pathname)
    if (!invalid && (!isApi(pathname) || allowed(req))) return false
    socket.on('error', () => {})
    socket.end(`HTTP/1.1 ${invalid ? '400 Bad Request' : '401 Unauthorized'}\r\nConnection: close\r\n\r\n`)
    return true
  }
  return { allowed, http, upgrade, launchCode }
}
