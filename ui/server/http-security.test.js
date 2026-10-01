import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { once } from 'node:events'
import { cloudConfig, createSecurity } from './security.js'
const env = { OPENROD_MODE: 'cloud', OPENROD_ORG_ID: 'acme', OPENROD_PUBLIC_ORIGIN: 'https://acme.example.com', GOOGLE_CLOUD_PROJECT: 'openshell-viewer', OPENROD_FIREBASE_API_KEY: 'key', OPENROD_FIREBASE_AUTH_DOMAIN: 'openshell-viewer.firebaseapp.com' }
const user = { uid: 'alice', emailVerified: true, providerData: [{providerId:'google.com'}], customClaims: { openrod_org: 'acme', openrod_role: 'member' } }
const decoded = { uid: 'alice', exp: Math.floor(Date.now()/1000)+3600, auth_time: Math.floor(Date.now()/1000), email_verified: true, firebase: {sign_in_provider:'google.com'} }
const fakeAuth = { verifySessionCookie: async () => decoded, getUser: async () => user, verifyIdToken: async token => { if (token !== 'valid') throw Error('bad'); return decoded }, createSessionCookie: async () => 'session' }
const headers = { host: 'acme.example.com', origin: env.OPENROD_PUBLIC_ORIGIN, 'content-type': 'application/json', 'x-openshell-console': '1' }
async function fixture(t) {
  const revoked = new Set()
  const security = createSecurity(cloudConfig(env), fakeAuth, { has: c => revoked.has(c), add: c => revoked.add(c) })
  const server = http.createServer((req, res) => security.middleware(req, res, () => { res.writeHead(200); res.end('protected') }))
  server.on('upgrade', async (req, socket) => {
    try { await security.authenticate(req); socket.end('HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n') }
    catch { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n') }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
  const port = server.address().port
  const request = async (path, options = {}) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers, ...options })
    const response = once(req, 'response'); req.end(options.body)
    const [res] = await response
    let body = ''; for await (const chunk of res) body += chunk
    return { status: res.statusCode, headers: res.headers, body }
  }
  return { request, port }
}
test('HTTP authentication covers streams, files, exports and secrets; config remains public', async t => {
  const { request } = await fixture(t)
  assert.equal((await request('/api/auth/config')).status, 200)
  for (const path of ['/api/os/overview', '/api/os/stream', '/api/os/downloads/token', '/api/os/activity/export', '/api/os/secrets']) assert.equal((await request(path)).status, 401, path)
  assert.equal((await request('/api/os/secrets', { headers: { ...headers, cookie: '__Host-openrod_session=session' } })).status, 200)
})
test('session exchange is same-origin, recent, and issues a secure HttpOnly cookie', async t => {
  const { request } = await fixture(t)
  const session = await request('/api/auth/session', { method: 'POST', body: JSON.stringify({ idToken: 'valid' }) })
  assert.equal(session.status, 200)
  assert.match(session.headers['set-cookie'][0], /__Host-openrod_session=session; Path=\/; HttpOnly; Secure; SameSite=Strict/)
  assert.equal((await request('/api/auth/session', { method: 'POST', headers: { ...headers, origin: 'https://evil.example' }, body: '{"idToken":"valid"}' })).status, 403)
  assert.equal((await request('/api/auth/session', { method: 'POST', body: '{"idToken":"invalid"}' })).status, 401)
  assert.equal((await request('/api/auth/session', { method: 'POST', body: 'invalid json' })).status, 400)
})
test('WebSocket upgrade requires the same verified session as HTTP', async t => {
  const { port } = await fixture(t)
  const socket = net.connect(port, '127.0.0.1')
  await once(socket, 'connect')
  socket.write('GET /api/os/terminal?ticket=stolen HTTP/1.1\r\nHost: acme.example.com\r\nOrigin: https://acme.example.com\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
  let output = ''; for await (const data of socket) output += data
  assert.match(output, /403 Forbidden/)
})

test('one proxied client cannot exhaust another client’s login quota', async t => {
  const { request } = await fixture(t)
  const attempt = ip => request('/api/auth/session', { method: 'POST', headers: { ...headers, 'x-openrod-client-ip': ip }, body: '{"idToken":"invalid"}' })
  for (let i = 0; i < 30; i++) assert.equal((await attempt('198.51.100.1')).status, 401)
  assert.equal((await attempt('198.51.100.1')).status, 429)
  assert.equal((await request('/api/auth/session', { method: 'POST', headers: { ...headers, 'x-openrod-client-ip': '198.51.100.2' }, body: '{"idToken":"valid"}' })).status, 200)
})
