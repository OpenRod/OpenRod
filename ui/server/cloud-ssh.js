import { randomUUID } from 'node:crypto'
import { STATUS_CODES } from 'node:http'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { WebSocketServer, createWebSocketStream } from 'ws'
import { WORKSPACE, gateway, sandboxView } from './gateway.js'
import { identityContext } from './security.js'
import { fail, runCli } from './openshell-cli.js'

const NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
export const SSH_PATH = '/api/os/ssh'
const TTL = 60_000
const proxyArgs = plan => ['ssh-proxy', '--gateway-name', plan.target.name, '--name', plan.name, '--workspace', 'default']

export function validateHostKeys(keys) {
  if (!Array.isArray(keys) || !keys.length || keys.length > 8) throw fail('No verified SSH host key is available.', 502)
  return [...new Set(keys.map(key => {
    if (typeof key !== 'string' || key.length > 8192 || !/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/]+={0,2}$/.test(key)) throw fail('Invalid SSH host key.', 502)
    const [type, encoded] = key.split(' '), bytes = Buffer.from(encoded, 'base64')
    if (bytes.length < 16 || bytes.readUInt32BE(0) !== type.length || bytes.subarray(4, 4 + type.length).toString() !== type) throw fail('Invalid SSH host key.', 502)
    return key
  }))]
}

export function createSshTickets({ now = Date.now, ttl = TTL } = {}) {
  const values = new Map()
  return {
    issue(plan) {
      const ticket = randomUUID(), expires = Math.min(now() + ttl, plan.sessionExpires)
      values.set(ticket, { ...plan, expires })
      setTimeout(() => values.delete(ticket), ttl).unref?.()
      return ticket
    },
    claim(ticket, principal) {
      const plan = values.get(ticket); values.delete(ticket)
      return plan && plan.expires > now() && plan.principal === principal ? plan : null
    },
    expires(ticket) { return values.get(ticket)?.expires },
  }
}
const tickets = createSshTickets()

async function loadContext(name) {
  const { client, target } = await gateway()
  const sandbox = sandboxView((await client.raw.getSandbox({ name, workspaceScope: WORKSPACE })).sandbox)
  return { sandbox, target }
}

function stopProxy(child) {
  try {
    if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM')
    else child.kill('SIGTERM')
  } catch {}
  const hardKill = setTimeout(() => {
    try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL') } catch {}
  }, 1000)
  hardKill.unref?.()
  child.once('close', () => clearTimeout(hardKill))
}

// ssh-proxy authenticates the gateway with the worker's own mTLS bundle. A
// loopback-only keyscan through that trusted stream obtains the actual SSH key
// (OpenShell terminates SSH, so sandbox /etc/ssh keys are not authoritative).
export async function discoverHostKeys({ sandbox, target }, dependencies = {}) {
  const spawnProcess = dependencies.spawnProcess ?? spawn
  const peers = new Set(), children = new Set()
  const server = createServer(socket => {
    peers.add(socket)
    const child = spawnProcess('/usr/bin/openshell', proxyArgs({ name: sandbox.name, target }), { shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] })
    children.add(child); child.stderr.resume()
    child.on('error', () => socket.destroy()); child.stdin.on('error', () => socket.destroy()); child.stdout.on('error', () => socket.destroy())
    socket.on('error', () => {}); socket.pipe(child.stdin); child.stdout.pipe(socket)
    socket.once('close', () => { peers.delete(socket); stopProxy(child) })
    child.once('close', () => { children.delete(child); socket.destroy() })
  })
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const result = await (dependencies.runCli ?? runCli)('/usr/bin/ssh-keyscan', ['-T', '5', '-p', String(server.address().port), '127.0.0.1'], { timeoutMs: 10_000, outputLimit: 64 * 1024 })
    if (result.timedOut || result.outputExceeded || result.code !== 0) throw fail('Could not verify the sandbox SSH host key.', 502)
    return validateHostKeys(result.stdout.split('\n').filter(line => line && !line.startsWith('#')).map(line => line.trim().split(/\s+/).slice(1, 3).join(' ')))
  } finally {
    for (const socket of peers) socket.destroy()
    for (const child of children) stopProxy(child)
    if (server.listening) await new Promise(resolve => server.close(resolve))
  }
}

export async function cloudSshRoute(method, parts, input, dependencies = {}) {
  if (method !== 'POST' || parts[0] !== 'sandboxes' || parts.length !== 3 || parts[2] !== 'ssh-ticket' || !NAME.test(parts[1] ?? '')) return undefined
  const principal = dependencies.principal ?? identityContext.getStore()
  if (!principal?.uid || !Number.isFinite(principal.expires) || principal.expires <= (dependencies.now ?? Date.now)()) throw fail('Authenticated SSH owner required.', 403)
  const context = await (dependencies.loadContext ?? loadContext)(parts[1])
  if (context.sandbox.phase !== 'ready') throw fail('This sandbox is not running.', 409)
  const hostKeys = validateHostKeys(await (dependencies.hostKeys ?? discoverHostKeys)(context))
  const store = dependencies.tickets ?? tickets
  const ticket = store.issue({ name: context.sandbox.name, target: context.target, principal: principal.uid, sessionExpires: principal.expires })
  return { ticket, expires: store.expires(ticket), hostKeys, user: 'sandbox' }
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 })
function refuse(socket, status) { socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nConnection: close\r\n\r\n`) }
export function cloudSshUpgrade(req, socket, head, isAllowed, principal, dependencies = {}) {
  const url = new URL(req.url ?? '/', 'http://local')
  if (url.pathname !== SSH_PATH) return false
  if (!isAllowed(req)) { refuse(socket, 403); return true }
  const uid = typeof principal === 'string' ? principal : principal?.uid
  const plan = (dependencies.tickets ?? tickets).claim(url.searchParams.get('ticket'), uid)
  if (!plan || !uid) { refuse(socket, 403); return true }
  wss.handleUpgrade(req, socket, head, ws => {
    let child
    try { child = (dependencies.spawnProcess ?? spawn)('/usr/bin/openshell', proxyArgs(plan), { shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] }) }
    catch { ws.close(1011); return }
    // stream APIs preserve binary bytes and propagate backpressure in both
    // directions. SSH control/errors never share this binary stream.
    const stream = createWebSocketStream(ws, { encoding: null })
    let cleaned = false
    const expiry = setTimeout(() => { ws.close(1008, 'Cloud authorization expired'); cleanup() }, Math.max(1, Math.min(plan.sessionExpires, principal?.expires ?? Infinity) - Date.now()))
    expiry.unref?.()
    const cleanup = () => { if (cleaned) return; cleaned = true; clearTimeout(expiry); stopProxy(child); stream.destroy() }
    child.stderr.resume()
    child.on('error', () => ws.close(1011)); child.stdin.on('error', () => ws.close(1011)); child.stdout.on('error', () => ws.close(1011))
    child.once('close', code => {
      // stdout.pipe(stream) finishes all queued writes before its finalizer
      // closes the WebSocket. Closing here would discard the writable queue.
      if (code !== 0) { if (ws.readyState === ws.OPEN) ws.close(1011); cleanup() }
    })
    stream.on('error', cleanup); ws.on('error', cleanup); ws.once('close', cleanup)
    stream.pipe(child.stdin); child.stdout.pipe(stream)
    ws.on('message', (_data, binary) => { if (!binary) ws.close(1003, 'Binary SSH frames required') })
  })
  return true
}
