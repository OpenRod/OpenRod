import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { WebSocket } from 'ws'

const module = await import('./cloud-ssh.js').catch(() => ({}))
const key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBQ0mhdsCYeaMy1QaI3/GDYUHJRTerTsKhXvrFTHkmEa'
const context = { sandbox: { name: 'demo', phase: 'ready' }, target: { name: 'owner-gateway' } }

test('SSH ticket is single-use, principal-scoped, short-lived and pins authenticated host keys', async () => {
  assert.equal(typeof module.createSshTickets, 'function')
  let now = 1000
  const tickets = module.createSshTickets({ now: () => now })
  const dependencies = { tickets, loadContext: async () => context, hostKeys: async () => [key], principal: { uid: 'alice', expires: 100000 }, now: () => now }
  const result = await module.cloudSshRoute('POST', ['sandboxes', 'demo', 'ssh-ticket'], { command: 'evil' }, dependencies)
  assert.deepEqual(result.hostKeys, [key])
  assert.equal(result.expires, 61000)
  assert.equal(tickets.claim(result.ticket, 'bob'), null)
  assert.equal(tickets.claim(result.ticket, 'alice'), null)
  const second = await module.cloudSshRoute('POST', ['sandboxes', 'demo', 'ssh-ticket'], {}, dependencies)
  const plan = tickets.claim(second.ticket, 'alice')
  assert.equal(plan.name, 'demo')
  assert.equal(plan.target.name, 'owner-gateway')
  assert.equal(plan.sessionExpires, 100000)
  assert.equal(tickets.claim(second.ticket, 'alice'), null)
  const third = await module.cloudSshRoute('POST', ['sandboxes', 'demo', 'ssh-ticket'], {}, dependencies)
  now = 61001
  assert.equal(tickets.claim(third.ticket, 'alice'), null)
})

test('tickets reject stopped sandboxes, missing owners, and invalid host keys', async () => {
  assert.equal(typeof module.cloudSshRoute, 'function')
  const base = { loadContext: async () => context, hostKeys: async () => [key], principal: { uid: 'alice', expires: Date.now() + 10000 } }
  await assert.rejects(module.cloudSshRoute('POST', ['sandboxes', 'demo', 'ssh-ticket'], {}, { ...base, principal: null }), { status: 403 })
  await assert.rejects(module.cloudSshRoute('POST', ['sandboxes', 'demo', 'ssh-ticket'], {}, { ...base, loadContext: async () => ({ ...context, sandbox: { ...context.sandbox, phase: 'stopped' } }) }), { status: 409 })
  await assert.rejects(module.cloudSshRoute('POST', ['sandboxes', 'demo', 'ssh-ticket'], {}, { ...base, hostKeys: async () => ['ssh-ed25519 invalid\nHost evil'] }), { status: 502 })
})

test('raw SSH websocket streams binary to fixed proxy argv and kills child on disconnect', async () => {
  assert.equal(typeof module.cloudSshUpgrade, 'function')
  const tickets = module.createSshTickets()
  const ticket = tickets.issue({ name: 'demo', target: context.target, principal: 'alice', sessionExpires: Date.now() + 5000 })
  const child = new EventEmitter()
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
  let invocation, killed = false, finishKill
  const stopped = new Promise(resolve => { finishKill = resolve })
  child.kill = () => { killed = true; finishKill() }
  const server = http.createServer()
  server.on('upgrade', (req, socket, head) => module.cloudSshUpgrade(req, socket, head, () => true, { uid: 'alice', expires: Date.now() + 5000 }, { tickets, spawnProcess: (file, args, opts) => { invocation = { file, args, opts }; return child } }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/os/ssh?ticket=${ticket}`)
  try {
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
    assert.equal(invocation.file, '/usr/bin/openshell')
    assert.deepEqual(invocation.args, ['ssh-proxy', '--gateway-name', 'owner-gateway', '--name', 'demo', '--workspace', 'default'])
    assert.equal(invocation.opts.shell, false)
    const input = new Promise(resolve => child.stdin.once('data', resolve))
    ws.send(Buffer.from([0, 255, 1])); assert.deepEqual(await input, Buffer.from([0, 255, 1]))
    const output = new Promise(resolve => ws.once('message', (data, binary) => resolve({ data, binary })))
    child.stdout.write(Buffer.from([2, 0, 254])); assert.deepEqual(await output, { data: Buffer.from([2, 0, 254]), binary: true })
    ws.close(); await new Promise(resolve => ws.once('close', resolve))
    await stopped; assert.equal(killed, true)
  } finally { ws.terminate(); await new Promise(resolve => server.close(resolve)) }
})

test('expired authorization kills the proxy even when a peer never acknowledges websocket close', async () => {
  const tickets = module.createSshTickets()
  const ticket = tickets.issue({ name: 'demo', target: context.target, principal: 'alice', sessionExpires: Date.now() + 100 })
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
  let killed = false; child.kill = () => { killed = true }
  const server = http.createServer()
  server.on('upgrade', (req, socket, head) => module.cloudSshUpgrade(req, socket, head, () => true, 'alice', { tickets, spawnProcess: () => child }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/os/ssh?ticket=${ticket}`)
  try {
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) }); ws.pause()
    await new Promise(resolve => setTimeout(resolve, 180)); assert.equal(killed, true)
  } finally { ws.terminate(); await new Promise(resolve => server.close(resolve)) }
})

test('successful proxy exit drains queued SSH stdout before closing the websocket', async () => {
  const tickets = module.createSshTickets(), expected = Buffer.alloc(256 * 1024, 0xa5)
  const ticket = tickets.issue({ name: 'demo', target: context.target, principal: 'alice', sessionExpires: Date.now() + 5000 })
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {}
  child.stdout.once('end', () => child.emit('close', 0))
  const server = http.createServer()
  server.on('upgrade', (req, socket, head) => module.cloudSshUpgrade(req, socket, head, () => true, 'alice', { tickets, spawnProcess: () => child }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/os/ssh?ticket=${ticket}`), chunks = []
  ws.on('message', data => chunks.push(data))
  try {
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
    const closed = new Promise(resolve => ws.once('close', resolve))
    for (let offset = 0; offset < expected.length; offset += 4096) child.stdout.write(expected.subarray(offset, offset + 4096))
    child.stdout.end(); await closed
    assert.deepEqual(Buffer.concat(chunks), expected)
  } finally { ws.terminate(); await new Promise(resolve => server.close(resolve)) }
})
