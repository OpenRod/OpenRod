import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { PassThrough, Writable } from 'node:stream'
import { createRequire } from 'node:module'
import { WebSocketServer } from 'ws'
const require = createRequire(import.meta.url)
let module = {}; try { module = require('./cloud-ssh-proxy.cjs') } catch {}

test('proxy refuses nonloopback origins, arbitrary targets, credentials and missing account scope', () => {
  assert.equal(typeof module.parseProxyArgs, 'function')
  const args = ['--origin', 'http://localhost:4311', '--sandbox', 'demo', '--owner', 'abcdef1234567890']
  assert.equal(module.parseProxyArgs(args).sandbox, 'demo')
  for (const origin of ['https://evil.example', 'http://localhost.evil:4311', 'http://u:p@localhost:4311', 'http://localhost:4311/path']) assert.throws(() => module.parseProxyArgs(['--origin', origin, ...args.slice(2)]))
  assert.throws(() => module.parseProxyArgs([...args, '--command', 'sh']))
  assert.throws(() => module.parseProxyArgs(args.slice(0, 4)))
})

test('proxy obtains ticket from exact local boundary and relays only binary SSH bytes', async () => {
  assert.equal(typeof module.runProxy, 'function')
  let request
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const data of req) body += data
    request = { url: req.url, headers: req.headers, body: JSON.parse(body) }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ticket: 'one-use' }))
  })
  const wss = new WebSocketServer({ noServer: true })
  let upgraded
  server.on('upgrade', (req, socket, head) => {
    upgraded = req
    wss.handleUpgrade(req, socket, head, ws => { ws.on('message', (data, binary) => { assert.equal(binary, true); ws.send(data, { binary: true }); setTimeout(() => ws.close(), 10) }) })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const input = new PassThrough(), output = new PassThrough(), data = []
  output.on('data', chunk => data.push(chunk))
  try {
    const running = module.runProxy({ origin, sandbox: 'demo', owner: 'abcdef1234567890' }, { input, output })
    input.write(Buffer.from([0, 255, 2])); await running
    assert.deepEqual(Buffer.concat(data), Buffer.from([0, 255, 2]))
    assert.equal(request.url, '/api/remote/os/sandboxes/demo/ssh-ticket')
    assert.equal(request.headers.origin, origin); assert.equal(request.headers['x-openshell-console'], '1')
    assert.deepEqual(request.body, { owner: 'abcdef1234567890' })
    assert.equal(upgraded.url, '/api/remote/os/ssh?ticket=one-use'); assert.equal(upgraded.headers.origin, origin)
    assert.equal(request.headers.authorization, undefined)
  } finally { input.destroy(); output.destroy(); for (const ws of wss.clients) ws.terminate(); wss.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})


test('proxy drains buffered binary output through a slow SSH consumer before returning', async () => {
  const server = http.createServer((_req, res) => res.end(JSON.stringify({ ticket: 'one-use' })))
  const wss = new WebSocketServer({ noServer: true })
  const expected = Buffer.alloc(128 * 1024, 0xa5)
  server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, ws => { for (let offset = 0; offset < expected.length; offset += 32768) ws.send(expected.subarray(offset, offset + 32768), { binary: true }); ws.close(1000) }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const input = new PassThrough(), chunks = []
  const output = new Writable({ highWaterMark: 16, write(chunk, _encoding, done) { setTimeout(() => { chunks.push(chunk); done() }, 20) } })
  try {
    await module.runProxy({ origin: `http://127.0.0.1:${server.address().port}`, sandbox: 'demo', owner: 'abcdef1234567890' }, { input, output })
    await new Promise(resolve => output.end(resolve)); assert.deepEqual(Buffer.concat(chunks), expected)
  } finally { input.destroy(); output.destroy(); for (const ws of wss.clients) ws.terminate(); wss.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})
