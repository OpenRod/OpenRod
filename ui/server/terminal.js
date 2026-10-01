import { identityContext } from './security.js'
// Browser terminals. xterm.js runs in the page, a WebSocket ends here, and the
// gateway's interactive exec sits behind it: the same RPC that
// `openshell sandbox exec --tty` uses, so nothing new reaches the sandbox.
//
// A page first POSTs for a ticket, then opens the socket with it. Browsers
// cannot add the console's header to a WebSocket handshake, so the ticket
// carries the same-origin proof instead: it is issued to a checked mutation,
// used once, and expires after a minute.
import { STATUS_CODES } from 'node:http'
import { randomUUID } from 'node:crypto'
import { WebSocketServer } from 'ws'
import { defaultSession, isSession, projectOf, sessionArgv } from '../src/lib/sandbox-session.js'
import { gateway, sandboxView } from './gateway.js'

const fail = (message, status = 400) => Object.assign(new Error(message), { status })
const NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
const ID = /^[0-9a-f-]{36}$/
export const TERMINAL_PATH = '/api/os/terminal'
const TICKET_TTL_MS = 60_000
// Output waiting for a slow page before reading from the sandbox pauses.
const BUFFER_LIMIT = 4 * 1024 * 1024

// A terminal dimension from the page: a small positive integer, or the fallback.
export const dimension = (value, fallback) => (Number.isInteger(value) && value > 0 && value <= 1000 ? value : fallback)

// What to run for a request, from the gateway's record and the page's choice.
// The page may ask for a shell or any agent the console launches; anything
// else is refused before a ticket exists.
export function planSession(sandbox, input = {}) {
  if (sandbox.phase !== 'ready') throw fail('This sandbox is not running.', 409)
  const session = input.session == null || input.session === '' ? defaultSession(sandbox) : input.session
  if (!isSession(session)) throw fail('Unknown session.')
  const project = projectOf(sandbox)
  return {
    name: sandbox.name,
    session,
    argv: sessionArgv(session),
    workdir: project ? `/sandbox/${project}` : '',
    cols: dimension(input.cols, 80),
    rows: dimension(input.rows, 24),
  }
}

// Single-use tickets with a short life. The clock is injectable for tests.
export function createTickets({ ttl = TICKET_TTL_MS, now = Date.now } = {}) {
  const tickets = new Map()
  return {
    issue(plan) {
      const ticket = randomUUID()
      tickets.set(ticket, { ...plan, expires: now() + ttl })
      setTimeout(() => tickets.delete(ticket), ttl).unref?.()
      return ticket
    },
    claim(ticket, principal) {
      const plan = ID.test(ticket ?? '') ? tickets.get(ticket) : undefined
      if (!plan) return null
      tickets.delete(ticket)
      return plan.expires > now() && plan.principal === principal ? plan : null
    },
    get size() { return tickets.size },
  }
}

const tickets = createTickets()

export async function terminalRoute(method, parts, input) {
  if (method === 'POST' && parts[0] === 'sandboxes' && parts.length === 3 && NAME.test(parts[1]) && parts[2] === 'terminal-session') {
    const { client, target, workspace, workspaceScope } = await gateway()
    const sandbox = { ...sandboxView((await client.raw.getSandbox({ name: parts[1], workspaceScope })).sandbox), workspace }
    const plan = { ...planSession(sandbox, input ?? {}), gateway: target.name, workspace }
    if (input?.setupLogin) {
      const { setupStore } = await import('./setups.js')
      const { executeInstaller } = await import('./setup-deployment.js')
      const setup = await setupStore.get(input.setupLogin)
      const item = setup.items.find(i => i.id === input.mcp)
      plan.argv = setupLoginArgv(item, setup.id, plan.session)
      const probe = await executeInstaller(client, sandbox, setup, ['codex'], 'probe')
      if (!probe.installed || !probe.targets.includes('codex') || !probe.items.includes(item.id) || probe.revision !== setup.revision) throw fail('Enable this Setup for Codex in the sandbox first.', 409)
      plan.argv = setupLoginArgv(item, setup.id, plan.session, probe.mcpNames?.codex?.[item.id])
      const help = await client.sandbox.exec(sandbox.name, ['codex', 'mcp', 'login', '--help'], {workspace,noLoginShell:true,timeoutSecs:10})
      if (!help.stdout.toString().includes('--no-browser')) throw fail('Update Codex in this image to a version with MCP --no-browser sign-in.',409)
      plan.workdir = '/sandbox'
    }
    return { ticket: tickets.issue({ ...plan, principal: identityContext.getStore()?.uid }), session: plan.session }
  }
  return undefined
}

function refuse(socket, status) {
  socket.write(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nConnection: close\r\n\r\n`)
  socket.destroy()
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 })

// Handles the console's own upgrade requests and leaves every other one (Vite's
// HMR socket) alone. `isLocal` is the same check the HTTP routes apply.
export function terminalUpgrade(req, socket, head, isLocal, principal) {
  const url = new URL(req.url ?? '/', 'http://local')
  if (url.pathname !== TERMINAL_PATH) return false
  if (!isLocal(req)) { refuse(socket, 403); return true }
  const plan = tickets.claim(url.searchParams.get('ticket'), principal)
  if (!plan || plan.principal !== principal) { refuse(socket, 403); return true }
  wss.handleUpgrade(req, socket, head, (ws) => { run(ws, plan).catch(() => { try { ws.close(1011) } catch {} }) })
  return true
}

// Frames from the page: binary is keyboard input, text is a control message.
export function controlOf(data, isBinary) {
  if (isBinary) return { type: 'stdin', data }
  let message
  try { message = JSON.parse(data.toString()) } catch { return null }
  if (message?.type === 'resize') return { type: 'resize', cols: dimension(message.cols, 0), rows: dimension(message.rows, 0) }
  return null
}

async function run(ws, plan) {
  const send = (message) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message)) }
  const { client } = await gateway(plan)
  let session
  try {
    session = await client.sandbox.execInteractive(plan.name, plan.argv, {
      workspace: plan.workspace,
      tty: true, cols: plan.cols, rows: plan.rows, workdir: plan.workdir,
      environment: { TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    })
  } catch (error) {
    send({ type: 'error', message: error.message })
    ws.close(1011)
    return
  }
  const running = () => session.exitCode === undefined
  // The tab may have closed while the exec was starting; a program that
  // prints nothing would otherwise keep the exec alive with nobody attached.
  if (ws.readyState !== ws.OPEN) { session.cancel(); return }
  ws.on('message', (data, isBinary) => {
    const frame = controlOf(data, isBinary)
    if (!frame || !running()) return
    try {
      if (frame.type === 'stdin') session.write(data)
      else if (frame.cols && frame.rows) session.resize(frame.cols, frame.rows)
    } catch { /* input raced the exit */ }
  })
  ws.on('close', () => { if (running()) session.cancel() })
  send({ type: 'ready' })
  const ping = setInterval(() => { if (ws.readyState === ws.OPEN) ws.ping() }, 30_000)
  try {
    for await (const event of session.output) {
      if (ws.readyState !== ws.OPEN) break
      if (event.type === 'exit') { send({ type: 'exit', exitCode: event.exitCode }); break }
      ws.send(event.data, { binary: true })
      while (ws.bufferedAmount > BUFFER_LIMIT && ws.readyState === ws.OPEN) await new Promise((resolve) => setTimeout(resolve, 20))
    }
    if (ws.readyState === ws.OPEN) ws.close(1000)
  } catch (error) {
    send({ type: 'error', message: error.message })
    if (ws.readyState === ws.OPEN) ws.close(1011)
  } finally {
    clearInterval(ping)
    if (running()) session.cancel()
  }
}

// Fixed argv only: neither the browser nor imported configuration supplies a shell command.
export function setupLoginArgv(item, setupId, session, installedName) {
  if (session !== 'codex' || !/^[a-f0-9]{24}$/.test(setupId) || !item?.config?.url || !/^[a-zA-Z0-9-]{1,100}$/.test(item.id) || item.disabled || item.issues?.length || item.credentialRef) throw fail('Choose an installed remote MCP for Codex sign-in.')
  if (installedName !== undefined && !/^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,99}$/.test(installedName)) throw fail('Invalid installed MCP name.')
  return ['codex', 'mcp', 'login', '--no-browser', installedName ?? `os-${setupId.slice(0,8)}-${item.id.slice(0,8)}`]
}
