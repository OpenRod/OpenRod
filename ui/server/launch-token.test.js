import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { createLaunchToken, createTokenGate, tokenCookie, tokenCookieName, tokenUrl } from './launch-token.js'

async function serve(t, token = createLaunchToken()) {
  const gate = createTokenGate(token)
  const server = http.createServer((req, res) => { if (!gate.http(req, res)) res.writeHead(200).end('ok') })
  server.on('upgrade', (req, socket) => { if (!gate.upgrade(req, socket)) socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: close\r\n\r\n') })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
  const port = server.address().port
  const request = async (target, headers = {}, method = 'GET') => {
    const req = http.request({ host: '127.0.0.1', port, path: target, headers, method })
    const response = once(req, 'response'); req.end()
    const [res] = await response
    let body = ''; for await (const chunk of res) body += chunk
    return { status: res.statusCode, headers: res.headers, body }
  }
  const upgrade = async (target, cookie) => {
    const socket = net.connect(port, '127.0.0.1'); await once(socket, 'connect')
    socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: http://127.0.0.1:${port}\r\n${cookie ? `Cookie: ${cookie}\r\n` : ''}Upgrade: websocket\r\nConnection: Upgrade\r\n\r\n`)
    let output = ''; for await (const data of socket) output += data
    return output
  }
  return { token, port, request, upgrade }
}

test('launch tokens are 32 random bytes and the link targets loopback', () => {
  const token = createLaunchToken()
  assert.match(token, /^[\w-]{43}$/)
  assert.notEqual(token, createLaunchToken())
  assert.equal(tokenUrl('127.0.0.1', 4600, token), `http://127.0.0.1:4600/?token=${token}`)
  assert.equal(tokenUrl('::1', 4600, 't'), 'http://[::1]:4600/?token=t')
  assert.throws(() => createTokenGate(''), /launch token/)
})

test('every API route requires the launch cookie; static pages do not', async t => {
  const { token, port, request } = await serve(t)
  for (const route of ['/api/os/overview', '/api/os/stream', '/api/os/downloads/x', '/api/auth/config', '/api/local-cloud/status', '/api']) {
    const denied = await request(route)
    assert.equal(denied.status, 401, route)
    assert.equal(JSON.parse(denied.body).code, 'CONSOLE_TOKEN_REQUIRED')
  }
  assert.equal((await request('/api/os/overview', { cookie: tokenCookie(port, token) })).status, 200)
  assert.equal((await request('/api/os/overview', { cookie: `theme=dark; ${tokenCookie(port, token)}` })).status, 200)
  assert.equal((await request('/')).status, 200)
  assert.equal((await request('/assets/index.js')).status, 200)
})

test('a wrong token or another port’s cookie is rejected', async t => {
  const { token, port, request } = await serve(t)
  assert.equal((await request('/api/os/overview', { cookie: tokenCookie(port, createLaunchToken()) })).status, 401)
  assert.equal((await request('/api/os/overview', { cookie: tokenCookie(port, token.slice(1)) })).status, 401)
  assert.equal((await request('/api/os/overview', { cookie: tokenCookie(port + 1, token) })).status, 401)
  const wrong = await request(`/?token=${createLaunchToken()}`)
  assert.equal(wrong.status, 302)
  assert.equal(wrong.headers['set-cookie'], undefined)
})

test('a valid link sets a per-port HttpOnly cookie and redirects without the token', async t => {
  const { token, port, request } = await serve(t)
  const response = await request(`/sandboxes?tab=files&token=${token}`)
  assert.equal(response.status, 302)
  assert.equal(response.headers.location, '/sandboxes?tab=files')
  assert.doesNotMatch(response.headers.location, /token/)
  assert.equal(response.headers['referrer-policy'], 'no-referrer')
  const [cookie] = response.headers['set-cookie']
  assert.equal(cookie, `${tokenCookieName(port)}=${token}; Path=/; HttpOnly; SameSite=Strict`)
  assert.equal(tokenCookieName(port), `openrod_token_${port}`)
  assert.equal((await request(`/?token=${token}`)).headers.location, '/')
  assert.equal((await request(`//evil.example/?token=${token}`)).status, 200)
  assert.equal((await request(`/?token=${token}`, { host: 'evil.example' })).status, 403)
})

test('two consoles on different ports keep separate cookies', async t => {
  const first = await serve(t), second = await serve(t)
  const cookies = [first, second].map(async ({ token, request }) => (await request(`/?token=${token}`)).headers['set-cookie'][0].split(';')[0])
  const [a, b] = await Promise.all(cookies)
  assert.notEqual(a.split('=')[0], b.split('=')[0])
  assert.equal((await first.request('/api/os/overview', { cookie: `${a}; ${b}` })).status, 200)
  assert.equal((await second.request('/api/os/overview', { cookie: `${a}; ${b}` })).status, 200)
  assert.equal((await second.request('/api/os/overview', { cookie: a })).status, 401)
})

test('WebSocket upgrades to the API require the launch cookie', async t => {
  const { token, port, upgrade } = await serve(t)
  assert.match(await upgrade('/api/os/terminal?ticket=x'), /^HTTP\/1\.1 401 /)
  assert.match(await upgrade('/api/os/terminal?ticket=x', tokenCookie(port, createLaunchToken())), /^HTTP\/1\.1 401 /)
  assert.match(await upgrade('/api/os/terminal?ticket=x', tokenCookie(port, token)), /^HTTP\/1\.1 101 /)
  assert.match(await upgrade('/vite-hmr'), /^HTTP\/1\.1 101 /)
})

test('targets the URL parser would rewrite are rejected before any handler', async t => {
  const { token, port, request, upgrade } = await serve(t)
  const cookie = tokenCookie(port, token)
  const rewritten = ['/api/os/../../abcdef/connections', '/api/os/%2e%2e/%2e%2e/abcdef/connections', '/api/os/%2E%2E/%2E%2E/abcdef/connections', '/api/os/./connections', '/api/os/%2e/connections', '/api/os/connections/..', '/x/../api/os/connections', '/assets/../index.html']
  for (const target of rewritten) {
    for (const headers of [{}, { cookie }]) {
      const response = await request(target, headers)
      assert.equal(response.status, 400, target)
      assert.equal(JSON.parse(response.body).error, 'Invalid request target')
      assert.equal((await request(`${target.replace('/connections', '/connections/disconnect')}?x=1`, headers, 'POST')).status, 400, target)
    }
  }
  for (const target of ['/api/os/../../abcdef/terminal?ticket=x', '/api/os/%2e%2e/%2e%2e/abcdef/terminal?ticket=x', '/api/os/./terminal?ticket=x', '/vite-hmr/..']) {
    assert.match(await upgrade(target), /^HTTP\/1\.1 400 /, target)
    assert.match(await upgrade(target, cookie), /^HTTP\/1\.1 400 /, target)
  }
  assert.equal((await request('/api/os/connections')).status, 401)
  assert.equal((await request('/api/os/connections/disconnect', {}, 'POST')).status, 401)
  assert.equal((await request('/api/os/connections', { cookie })).status, 200)
  assert.equal((await request('/api/os/connections/disconnect?x=a/../b', { cookie }, 'POST')).status, 200)
  assert.equal((await request('/assets/index-a1b2c3d4.js?v=1')).status, 200)
  assert.equal((await request('/.well-known/x')).status, 200)
  assert.equal((await request(`/sandboxes/a%20b?token=${token}`)).headers.location, '/sandboxes/a%20b')
})

test('the local console API enforces the launch cookie on HTTP and terminal upgrades', { timeout: 15000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'console-launch-token-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const token = createLaunchToken()
  const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: path.join(root, 'config'), OPENSHELL_CONSOLE_DATA_DIR: path.join(root, 'state'), OPENSHELL_GATEWAY: '', OPENSHELL_WORKSPACE: '', OPENSHELL_CONSOLE_SWEEP: '', OPENROD_MODE: 'local' }
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { createServer } from 'node:http'
    import { createOpenShellApi } from ${JSON.stringify(new URL('./api.js', import.meta.url).href)}
    const server = createServer((request, response) => api.middleware(request, response, () => response.writeHead(404).end()))
    const api = createOpenShellApi({ httpServer: server, token: ${JSON.stringify(token)} })
    server.listen(0, '127.0.0.1', () => console.log('READY ' + server.address().port))
    process.on('SIGTERM', async () => { await api.close(); server.close(() => process.exit(0)); server.closeAllConnections() })
  `], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const stopped = new Promise(resolve => child.once('close', resolve))
  t.after(async () => { child.kill('SIGTERM'); const deadline = setTimeout(() => child.kill('SIGKILL'), 3000); await stopped; clearTimeout(deadline) })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  const port = await new Promise((resolve, reject) => {
    let output = ''
    child.once('exit', code => reject(new Error(`Console exited ${code}: ${stderr}`)))
    child.stdout.on('data', chunk => { output += chunk; const match = /READY (\d+)/.exec(output); if (match) resolve(Number(match[1])) })
  })
  const origin = `http://127.0.0.1:${port}`, cookie = tokenCookie(port, token)
  for (const route of ['/api/auth/config', '/api/os/context', '/api/os/stream']) assert.equal((await fetch(origin + route)).status, 401, route)
  assert.equal((await fetch(origin + '/api/os/context', { headers: { cookie: tokenCookie(port, createLaunchToken()) } })).status, 401)
  const config = await fetch(origin + '/api/auth/config', { headers: { cookie } })
  assert.equal(config.status, 200)
  assert.equal((await config.json()).mode, 'local')
  assert.equal((await fetch(origin + '/api/os/context', { headers: { cookie } })).status, 200)
  const rebound = http.request({ host: '127.0.0.1', port, path: '/api/os/context', headers: { cookie, host: 'evil.example' } }); rebound.end()
  const [rebinding] = await once(rebound, 'response'); rebinding.resume()
  assert.equal(rebinding.statusCode, 403)
  // fetch() would normalize these targets before sending them.
  const raw = (target, headers = {}, method = 'GET') => new Promise((resolve, reject) => http.request({ host: '127.0.0.1', port, path: target, headers, method }, res => { res.resume(); resolve(res.statusCode) }).on('error', reject).end(method === 'POST' ? '{}' : undefined))
  const mutation = { 'content-type': 'application/json', 'x-openshell-console': '1', origin }
  for (const target of ['/api/os/../../abcdef/connections', '/api/os/%2e%2e/%2e%2e/abcdef/connections', '/api/os/./connections']) {
    assert.equal(await raw(target), 400, target)
    assert.equal(await raw(`${target}/disconnect`, mutation, 'POST'), 400, target)
  }
  assert.equal(await raw('/api/os/connections/disconnect', mutation, 'POST'), 401)
  assert.equal(await raw('/api/os/connections'), 401)
  assert.equal(await raw('/api/os/connections', { cookie }), 200)
  const redirect = await fetch(`${origin}/?token=${token}`, { redirect: 'manual' })
  assert.equal(redirect.status, 302)
  assert.equal(redirect.headers.get('location'), '/')
  assert.match(redirect.headers.get('set-cookie'), new RegExp(`^openrod_token_${port}=`))
  const reply = target => new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${origin}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${Buffer.from('a'.repeat(16)).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`))
    let data = ''
    socket.on('data', chunk => { data += chunk }).on('end', () => resolve(data)).on('error', reject)
  })
  assert.match(await reply('/api/os/terminal?ticket=x'), /^HTTP\/1\.1 401 /)
  for (const target of ['/api/os/../../abcdef/terminal?ticket=x', '/api/os/%2e%2e/os/terminal?ticket=x']) assert.match(await reply(target), /^HTTP\/1\.1 400 /, target)
})

test('the API router matches /api/os on the normalized path, as the gates do', { timeout: 15000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'console-route-path-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: path.join(root, 'config'), OPENSHELL_CONSOLE_DATA_DIR: path.join(root, 'state'), OPENSHELL_GATEWAY: '', OPENSHELL_WORKSPACE: '', OPENSHELL_CONSOLE_SWEEP: '' }
  // A pass-through boundary isolates the router from the local-only token gate.
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { createServer } from 'node:http'
    import { createOpenShellApi } from ${JSON.stringify(new URL('./api.js', import.meta.url).href)}
    const api = createOpenShellApi({ security: { config: { mode: 'worker' }, isAllowed: () => true, middleware: (req, res, next) => next() } })
    const server = createServer((request, response) => api.middleware(request, response, () => response.writeHead(404).end('next')))
    server.listen(0, '127.0.0.1', () => console.log('READY ' + server.address().port))
  `], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const stopped = new Promise(resolve => child.once('close', resolve))
  t.after(() => { child.kill('SIGKILL'); return stopped })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  const port = await new Promise((resolve, reject) => {
    let output = ''
    child.once('exit', code => reject(new Error(`Console exited ${code}: ${stderr}`)))
    child.stdout.on('data', chunk => { output += chunk; const match = /READY (\d+)/.exec(output); if (match) resolve(Number(match[1])) })
  })
  for (const target of ['/api/os/../../abcdef/connections', '/api/os/%2e%2e/%2e%2e/abcdef/connections']) {
    const req = http.request({ host: '127.0.0.1', port, path: target }); req.end()
    const [res] = await once(req, 'response')
    let body = ''; for await (const chunk of res) body += chunk
    assert.deepEqual([res.statusCode, body], [404, 'next'], target)
  }
})
