import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { cloudOrigin } from './cloud-origin.js'
import { tokenCookie } from './launch-token.js'
import { releaseConfig } from './security.js'
const TOKEN = 'test-launch-token-' + 'x'.repeat(32)

test('cloud defaults to the hosted console and supports overrides or explicit disabling', () => {
  assert.equal(cloudOrigin({}), 'https://console.openrod.io')
  assert.equal(cloudOrigin({ OPENROD_CLOUD_ORIGIN: '' }), null)
  assert.equal(cloudOrigin({ OPENROD_CLOUD_ORIGIN: '   ' }), null)
  assert.equal(cloudOrigin({ OPENROD_CLOUD_ORIGIN: 'https://cloud.example.test' }), 'https://cloud.example.test')
  for (const value of ['http://cloud.example.test', 'https://cloud.example.test/path', 'https://user@cloud.example.test', 'nope']) assert.throws(() => cloudOrigin({ OPENROD_CLOUD_ORIGIN: value }), /OPENROD_CLOUD_ORIGIN/)
})

test('cloud and worker startup fail closed without deployment configuration', async () => {
  assert.equal(releaseConfig({}).mode, 'local')
  for (const mode of ['cloud', 'worker']) {
    assert.throws(() => releaseConfig({ OPENROD_MODE: mode }), /requires/)
    const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('OPENROD_')))
    const child = spawnSync(process.execPath, ['--no-warnings', fileURLToPath(new URL('./start.js', import.meta.url))], { env: { ...clean, OPENROD_MODE: mode }, encoding: 'utf8', timeout: 10000 })
    assert.equal(child.status, 1, mode)
    assert.match(child.stderr.trim(), /requires/, mode)
  }
})

for (const enabled of [true, false]) test(`local console ${enabled ? 'offers hosted cloud without contacting it before sign-in' : 'refuses cloud operations when explicitly disabled'}`, { timeout: 15000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'console-cloud-soon-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const moduleUrl = new URL('./api.js', import.meta.url).href
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(root, 'config'), OPENSHELL_CONSOLE_DATA_DIR: path.join(root, 'state'), OPENSHELL_GATEWAY: '', OPENSHELL_WORKSPACE: '', OPENSHELL_CONSOLE_SWEEP: '', OPENROD_MODE: 'local' }
  if (enabled) delete env.OPENROD_CLOUD_ORIGIN
  else env.OPENROD_CLOUD_ORIGIN = ''
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { createServer } from 'node:http'
    import https from 'node:https'
    https.request = () => { throw new Error('Unexpected outbound cloud request before sign-in') }
    import { createOpenShellApi } from ${JSON.stringify(moduleUrl)}
    const server = createServer((request, response) => api.middleware(request, response, () => response.writeHead(404).end()))
    const api = createOpenShellApi({ httpServer: server, token: ${JSON.stringify(TOKEN)} })
    server.listen(0, '127.0.0.1', () => console.log('READY http://127.0.0.1:' + server.address().port))
    process.on('SIGTERM', async () => { await api.close(); server.close(() => process.exit(0)); server.closeAllConnections() })
  `], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const stopped = new Promise((resolve) => child.once('close', resolve))
  t.after(async () => { child.kill('SIGTERM'); const deadline = setTimeout(() => child.kill('SIGKILL'), 3000); await stopped; clearTimeout(deadline) })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const origin = await new Promise((resolve, reject) => {
    let output = ''
    child.once('exit', (code) => reject(new Error(`Console exited ${code}: ${stderr}`)))
    child.stdout.on('data', (chunk) => { output += chunk; const match = /READY (http:\/\/127\.0\.0\.1:\d+)/.exec(output); if (match) resolve(match[1]) })
  })
  const port = Number(new URL(origin).port), cookie = tokenCookie(port, TOKEN)
  const headers = { origin, cookie, 'content-type': 'application/json', 'x-openshell-console': '1' }
  const ticket = 'openrod-user-' + 'a'.repeat(24) + '.' + 'b'.repeat(64)
  const requests = [
    ['POST', '/api/os/cloud-transfer', { name: 'demo', ticket }],
    ['GET', '/api/os/cloud-export?name=demo'],
    ['POST', '/api/os/cloud-import', { version: 1 }],
    ['POST', '/api/local-cloud/start', { origin }],
    ['POST', '/api/local-cloud/finish', { nonce: 'n', code: 'c' }],
    ['POST', '/api/local-cloud/disconnect', {}],
    ['GET', '/api/remote/os/sandboxes'],
    ['POST', '/api/remote/os/sandboxes', { name: 'demo' }],
  ]
  const status = await fetch(origin + '/api/local-cloud/status', { headers: { origin, cookie } })
  assert.equal(status.status, 200)
  const connection = await status.json()
  assert.equal(connection.available, enabled)
  assert.equal(connection.connected, false)
  if (enabled) {
    assert.equal(connection.origin, 'https://console.openrod.io')
    const anonymous = await fetch(origin + '/api/local-cloud/status')
    assert.equal(anonymous.status, 401)
    for (const [method, route] of [['GET', '/api/local-cloud/machine'], ['POST', '/api/local-cloud/machine'], ['GET', '/api/remote/os/sandboxes']]) {
      const response = await fetch(origin + route, { method, headers, ...(method === 'POST' ? { body: '{}' } : {}) })
      assert.equal(response.status, 401, route)
    }
    const start = await fetch(origin + '/api/local-cloud/start', { method: 'POST', headers, body: JSON.stringify({ origin }) })
    assert.equal(start.status, 200)
    const handoff = await start.json()
    const cloudUrl = new URL(handoff.url)
    assert.equal(cloudUrl.origin, connection.origin)
    assert.equal(cloudUrl.searchParams.get('handoff'), '1')
    const bound = JSON.parse(Buffer.from(cloudUrl.hash.slice('#local-connect='.length), 'base64url'))
    assert.equal(bound.origin, origin)
    assert.equal(bound.nonce, handoff.nonce)
    assert.equal(bound.challenge, handoff.challenge)
    return
  }
  for (const [method, route, body] of requests) {
    const response = await fetch(origin + route, { method, headers: body ? headers : { origin, cookie }, body: body && JSON.stringify(body) })
    assert.equal(response.status, 409, route)
    assert.deepEqual(await response.json(), { error: 'Cloud is coming soon.' }, route)
  }
  const reply = await new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(`GET /api/remote/os/terminal?owner=x HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${origin}\r\nCookie: ${cookie}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${Buffer.from('a'.repeat(16)).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`))
    let data = ''
    socket.on('data', (chunk) => { data += chunk }).on('end', () => resolve(data)).on('error', reject)
  })
  assert.match(reply, /^HTTP\/1\.1 409 /)
  assert.match(reply, /Cloud is coming soon\./)
})
