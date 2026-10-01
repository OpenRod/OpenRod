import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { WebSocket, WebSocketServer } from 'ws'
import { createLocalCloud } from './local-cloud.js'
import { createLocalCloudNative } from './local-cloud-native.js'
import { cloudRouter } from './cloud-proxy.js'
import { verifyWorkerRequest } from './worker-auth.js'

const ownerOf = uid => createHash('sha256').update(uid).digest('hex').slice(0, 16)
const context = '["same-gateway","default"]'

// Exercise both real relays and the worker's signed owner check. Both workers
// deliberately use the same gateway, workspace, sandbox name and terminal ticket.
async function fixture(t, { native } = {}) {
  const servers = [], sockets = new Set(), websocketServers = [], requests = []
  let bridge
  t.after(async () => {
    bridge?.close()
    for (const socket of sockets) socket.terminate()
    for (const wss of websocketServers) for (const socket of wss.clients) socket.terminate()
    await Promise.all(servers.map(server => {
      server.closeAllConnections()
      return new Promise(resolve => server.close(resolve))
    }))
    for (const wss of websocketServers) wss.close()
  })
  const listen = async server => {
    servers.push(server)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    return `http://127.0.0.1:${server.address().port}`
  }
  const targets = {}
  for (const [uid, key] of [['alice', 'a'.repeat(64)], ['bob', 'b'.repeat(64)]]) {
    const worker = http.createServer(async (req, res) => {
      try {
        const identity = verifyWorkerRequest(key, uid, req)
        requests.push({ uid: identity.uid, method: req.method, path: req.url })
        for await (const _chunk of req) { /* Drain forwarded JSON bodies. */ }
        res.setHeader('content-type', 'application/json')
        if (req.url.startsWith('/api/os/downloads/')) {
          res.setHeader('content-type', 'application/octet-stream')
          res.end(`${uid} workspace file`)
          return
        }
        res.end(JSON.stringify(req.url.startsWith('/api/os/sandboxes/demo/terminal-session')
          ? { ticket: 'same-ticket', owner: uid }
          : req.url.startsWith('/api/os/files/demo/download')
            ? { token: 'same-download-token', owner: uid }
            : { name: 'demo', phase: 'ready', owner: uid, locations: [], sandboxes: [], templates: [] }))
      } catch {
        res.writeHead(403).end()
      }
    })
    const wss = new WebSocketServer({ noServer: true })
    websocketServers.push(wss)
    worker.on('upgrade', (req, socket, head) => {
      try {
        const identity = verifyWorkerRequest(key, uid, req)
        requests.push({ uid: identity.uid, method: 'WS', path: req.url })
        wss.handleUpgrade(req, socket, head, ws => {
          ws.send(JSON.stringify({ owner: uid, name: 'demo' }))
          ws.on('error', () => {})
        })
      } catch {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      }
    })
    const origin = await listen(worker)
    targets[uid] = { uid, key, state: 'ready', address: '127.0.0.1', port: Number(new URL(origin).port) }
  }
  const expires = Date.now() + 600_000
  const identities = Object.fromEntries(['alice', 'bob'].map(uid => [uid, { uid, email: `${uid}@example.com`, expires, role: 'member', org: 'test' }]))
  const connections = {
    redeem: async code => ({ token: `grant-${code}`, user: identities[code], expires }),
    authenticate: async token => {
      const identity = identities[token?.replace(/^grant-/, '')]
      if (!identity) throw Object.assign(new Error('Unauthorized'), { status: 401 })
      return identity
    },
    revoke: async () => {},
  }
  const central = http.createServer()
  const centralOrigin = await listen(central)
  const security = { config: { origin: centralOrigin, host: new URL(centralOrigin).host } }
  const machines = { target: async identity => targets[identity.uid], store: { get: async uid => targets[uid] } }
  const routes = cloudRouter(security, machines, {}, {}, { connections })
  central.on('request', (req, res) => routes.publicRoutes(req, res, () => res.writeHead(404).end()))
  central.on('upgrade', (req, socket, head) => routes.upgrade(req, socket, head))
  bridge = createLocalCloud({ origin: centralOrigin, allowTestHttp: true, native })
  const local = http.createServer((req, res) => bridge.middleware(req, res, () => res.writeHead(404).end()))
  local.on('upgrade', (req, socket, head) => bridge.upgrade(req, socket, head))
  const base = await listen(local)
  const request = (path, { owner, body } = {}) => fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      origin: base,
      ...(owner ? { 'x-openrod-local-owner': owner } : {}),
      'x-openshell-context': context,
      'x-openshell-location': '1',
      ...(body === undefined ? {} : { 'content-type': 'application/json', 'x-openshell-console': '1' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const connect = async uid => {
    const started = await (await request('/api/local-cloud/start', { body: { origin: base } })).json()
    const finished = await request('/api/local-cloud/finish', { body: { nonce: started.nonce, code: uid } })
    assert.equal(finished.status, 200)
    return finished.json()
  }
  const terminal = (owner, ticket = 'same-ticket') => {
    const url = new URL('/api/remote/os/terminal', base)
    url.protocol = 'ws:'
    url.searchParams.set('ticket', ticket)
    if (owner) url.searchParams.set('owner', owner)
    const socket = new WebSocket(url, { origin: base, handshakeTimeout: 2000 })
    sockets.add(socket)
    socket.on('error', () => {})
    return socket
  }
  return { base, request, connect, terminal, requests }
}

test('another browser account switch cannot route a retained owner API to the replacement worker', { timeout: 10_000 }, async t => {
  const { request, connect, requests } = await fixture(t)
  const alice = ownerOf('alice'), bob = ownerOf('bob')
  assert.equal((await connect('alice')).user.uid, 'alice')
  assert.equal((await (await request('/api/remote/os/sandboxes/demo', { owner: alice })).json()).owner, 'alice')
  assert.equal((await request('/api/local-cloud/inventory', { owner: alice })).status, 200)

  // A second browser changes the shared server grant; browser A retains alice.
  assert.equal((await connect('bob')).user.uid, 'bob')
  const before = requests.length
  for (const [path, body] of [
    ['/api/remote/os/sandboxes/demo'],
    ['/api/remote/os/sandboxes/demo/delete', {}],
    ['/api/remote/os/sandboxes/demo/terminal-session', { session: 'shell' }],
    ['/api/local-cloud/inventory'],
  ]) {
    const response = await request(path, { owner: alice, body })
    assert.equal(response.status, 403, path)
  }
  assert.equal((await request('/api/remote/os/sandboxes/demo')).status, 403, 'missing browser owner must fail closed')
  assert.equal(requests.length, before, 'stale calls must not reach either worker')
  assert.equal((await (await request('/api/remote/os/sandboxes/demo', { owner: bob })).json()).owner, 'bob')
  assert.equal((await request('/api/local-cloud/inventory', { owner: bob })).status, 200)
})

test('account switch closes the retained terminal and rejects reconnecting it to the replacement owner', { timeout: 10_000 }, async t => {
  const { request, connect, terminal, requests } = await fixture(t)
  const alice = ownerOf('alice'), bob = ownerOf('bob')
  await connect('alice')
  const ticket = await (await request('/api/remote/os/sandboxes/demo/terminal-session', { owner: alice, body: { session: 'shell' } })).json()
  const first = terminal(alice, ticket.ticket)
  const firstMessage = once(first, 'message')
  await once(first, 'open')
  assert.equal(JSON.parse(String((await firstMessage)[0])).owner, 'alice')
  const closed = once(first, 'close')
  await connect('bob')
  await closed

  const before = requests.length
  for (const owner of [alice, undefined]) {
    const retry = terminal(owner, ticket.ticket)
    const rejected = await once(retry, 'unexpected-response')
    assert.equal(rejected[1].statusCode, 403)
    rejected[1].resume()
    retry.terminate()
  }
  assert.equal(requests.length, before, 'retained terminal retries must not enter bob worker')
  const next = terminal(bob)
  const nextMessage = once(next, 'message')
  await once(next, 'open')
  assert.equal(JSON.parse(String((await nextMessage)[0])).owner, 'bob')
})

test('prepared cloud file download remains pinned to its browser account', { timeout: 10_000 }, async t => {
  const { request, connect, requests } = await fixture(t)
  const alice = ownerOf('alice'), bob = ownerOf('bob')
  await connect('alice')
  const prepared = await request('/api/remote/os/files/demo/download', { owner: alice, body: { path: '/sandbox/file.txt' } })
  assert.equal(prepared.status, 200)
  const { token } = await prepared.json()
  // Browser links carry the captured owner in the query, not a fetch header.
  const download = `/api/remote/os/downloads/${token}?owner=${alice}&context=${encodeURIComponent(context)}&location=1`
  const first = await request(download)
  assert.equal(first.status, 200)
  assert.equal(await first.text(), 'alice workspace file')
  await connect('bob')
  const before = requests.length
  assert.equal((await request(download)).status, 403)
  assert.equal(requests.length, before, 'an old download link must not enter bob worker')
  const current = await request(download.replace(`owner=${alice}`, `owner=${bob}`))
  assert.equal(current.status, 200)
  assert.equal(await current.text(), 'bob workspace file')
})

test('an account switch while a native request body arrives cannot change its cloud owner', { timeout: 10_000 }, async t => {
  let entered
  const bodyPending = new Promise(resolve => { entered = resolve })
  const actualNative = createLocalCloudNative()
  const { base, request, connect, requests } = await fixture(t, {
    native: (req, res, target, services) => { entered(); return actualNative(req, res, target, services) },
  })
  await connect('alice')
  const body = JSON.stringify({ editor: 'unknown-editor' })
  const streamed = http.request(new URL('/api/remote/os/sandboxes/demo/editor', base), {
    method: 'POST', headers: {
      origin: base, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
      'x-openshell-console': '1', 'x-openrod-local-owner': ownerOf('alice'), 'x-openshell-context': context,
    },
  })
  t.after(() => streamed.destroy())
  const response = once(streamed, 'response')
  streamed.flushHeaders()
  await bodyPending
  await connect('bob')
  const before = requests.length
  streamed.end(body)
  const [result] = await response
  result.resume()
  assert.equal(result.statusCode, 403)
  assert.equal(requests.length, before, 'native sandbox lookup must never enter the replacement worker')
  assert.equal((await (await request('/api/remote/os/sandboxes/demo', { owner: ownerOf('bob') })).json()).owner, 'bob')
})
