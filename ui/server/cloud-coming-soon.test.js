import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { cloudOrigin } from './cloud-origin.js'
import { tokenCookie } from './launch-token.js'
const TOKEN = 'test-launch-token-' + 'x'.repeat(32)

test('cloud origin is unset by default and must be an HTTPS origin when configured', () => {
  assert.equal(cloudOrigin({}), null)
  assert.equal(cloudOrigin({ OPENROD_CLOUD_ORIGIN: 'https://cloud.example.test' }), 'https://cloud.example.test')
  for (const value of ['http://cloud.example.test', 'https://cloud.example.test/path', 'https://user@cloud.example.test', 'nope']) assert.throws(() => cloudOrigin({ OPENROD_CLOUD_ORIGIN: value }), /OPENROD_CLOUD_ORIGIN/)
})

test('local console refuses every cloud endpoint while cloud is unconfigured', { timeout: 15000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'console-cloud-soon-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const moduleUrl = new URL('./api.js', import.meta.url).href
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(root, 'config'), OPENSHELL_CONSOLE_DATA_DIR: path.join(root, 'state'), OPENSHELL_GATEWAY: '', OPENSHELL_WORKSPACE: '', OPENSHELL_CONSOLE_SWEEP: '', OPENROD_MODE: 'local' }
  delete env.OPENROD_CLOUD_ORIGIN
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { createServer } from 'node:http'
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
    ['GET', '/api/local-cloud/status'],
    ['POST', '/api/local-cloud/start', { origin }],
    ['POST', '/api/local-cloud/finish', { nonce: 'n', code: 'c' }],
    ['POST', '/api/local-cloud/disconnect', {}],
    ['GET', '/api/remote/os/sandboxes'],
    ['POST', '/api/remote/os/sandboxes', { name: 'demo' }],
  ]
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
