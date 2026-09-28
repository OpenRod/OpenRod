import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { WORKSPACE, gateway, iso } from './gateway.js'

// Ingress: the ways into a sandbox. OpenShell sandboxes accept nothing inbound
// on their own; every way in is something the gateway opened on purpose:
// exposed services (a gateway URL routed to a loopback port inside), terminal
// and exec sessions, and file transfers.
//
// OpenShell has no expiry for exposed services, so the console adds one. The
// deadline is kept on disk next to the console and enforced by a sweep that
// runs while the console runs, and once on startup for anything that came due
// while it was stopped.

const fail = (message, status = 400) => Object.assign(new Error(message), { status })
const SANDBOX = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
const SERVICE = /^([a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?)?$/
const STATE_FILE = path.resolve(import.meta.dirname, '../.state/ingress.json')
const MAX_MINUTES = 7 * 24 * 60

const keyOf = (sandbox, name) => `${sandbox}/${name}`

async function readDeadlines() {
  try { return JSON.parse(await fs.readFile(STATE_FILE, 'utf8')) } catch { return {} }
}
async function writeDeadlines(deadlines) {
  await fs.mkdir(path.dirname(STATE_FILE), { recursive: true })
  await fs.writeFile(STATE_FILE, `${JSON.stringify(deadlines, null, 2)}\n`)
}

function serviceView(s, deadlines) {
  const e = s.endpoint
  return {
    sandbox: e.sandbox,
    name: e.name,
    port: e.targetPort,
    url: s.url || null,
    createdAt: iso(e.metadata?.createdTime),
    expiresAt: deadlines[keyOf(e.sandbox, e.name)]?.expiresAt ?? null,
  }
}

async function listServices() {
  const { client } = await gateway()
  const [response, deadlines] = await Promise.all([
    client.raw.listServices({ workspaceScope: WORKSPACE, pageSize: 1000 }),
    readDeadlines(),
  ])
  return response.services.map((s) => serviceView(s, deadlines))
}

function deadlineFrom(minutes) {
  if (minutes === null || minutes === undefined) return null
  const m = Number(minutes)
  if (!Number.isInteger(m) || m < 5 || m > MAX_MINUTES) throw fail('Pick between 5 minutes and 7 days, or "until I close it".')
  return new Date(Date.now() + m * 60000).toISOString()
}

async function setDeadline(sandbox, name, expiresAt) {
  const deadlines = await readDeadlines()
  if (expiresAt) deadlines[keyOf(sandbox, name)] = { expiresAt }
  else delete deadlines[keyOf(sandbox, name)]
  await writeDeadlines(deadlines)
}

export async function expose({ sandbox, name = '', port, closeAfterMinutes }) {
  if (!SANDBOX.test(sandbox ?? '')) throw fail('Unknown sandbox.')
  if (!SERVICE.test(name)) throw fail('Service names use lowercase letters, digits and dashes (up to 32).')
  const targetPort = Number(port)
  if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) throw fail('Ports are 1–65535.')
  const expiresAt = deadlineFrom(closeAfterMinutes)
  const { client } = await gateway()
  const response = await client.raw.exposeService({ sandbox, name, targetPort, domain: true, workspaceScope: WORKSPACE, requestId: randomUUID() })
  await setDeadline(sandbox, name, expiresAt)
  return { url: response.url || null, expiresAt }
}

export async function close({ sandbox, name = '' }, reason = 'closed') {
  if (!SANDBOX.test(sandbox ?? '') || !SERVICE.test(name)) throw fail('Unknown service.')
  const { client } = await gateway()
  await client.raw.deleteService({ sandbox, name, allowMissing: true, workspaceScope: WORKSPACE, requestId: randomUUID() })
  await setDeadline(sandbox, name, null)
  return { ok: true, reason }
}

async function extend({ sandbox, name = '', closeAfterMinutes }) {
  if (!SANDBOX.test(sandbox ?? '') || !SERVICE.test(name)) throw fail('Unknown service.')
  const services = await listServices()
  if (!services.some((s) => s.sandbox === sandbox && s.name === name)) throw fail('That service is no longer open.')
  const expiresAt = deadlineFrom(closeAfterMinutes)
  await setDeadline(sandbox, name, expiresAt)
  return { expiresAt }
}

// Session lifetime is gateway configuration, not an API setting. Read it from
// the same file the Homebrew service starts the gateway with, and report
// "not set" rather than guess at a default.
async function sessionPolicy() {
  const candidates = [process.env.OPENSHELL_GATEWAY_CONFIG, '/opt/homebrew/var/openshell/gateway.toml', path.join(process.env.HOME ?? '', '.config/openshell/gateway.toml')].filter(Boolean)
  for (const file of candidates) {
    try {
      const text = await fs.readFile(file, 'utf8')
      const m = /^\s*ssh_session_ttl_secs\s*=\s*(\d+)/m.exec(text)
      return { file, ttlSeconds: m ? Number(m[1]) : null }
    } catch { /* try the next location */ }
  }
  return { file: null, ttlSeconds: null }
}

export async function ingressOverview() {
  const { target } = await gateway()
  const [services, sessions] = await Promise.all([listServices(), sessionPolicy()])
  return {
    services,
    sessions,
    auth: { mode: target.authMode, remote: target.remote, gateway: target.name },
  }
}

// ---- the sweep --------------------------------------------------------------

let sweeping = false
export async function sweep(log = () => {}) {
  if (sweeping) return
  sweeping = true
  try {
    const deadlines = await readDeadlines()
    const now = Date.now()
    const due = Object.entries(deadlines).filter(([, d]) => Date.parse(d.expiresAt) <= now)
    for (const [key] of due) {
      const [sandbox, ...rest] = key.split('/')
      const name = rest.join('/')
      try { await close({ sandbox, name }, 'expired'); log(`closed expired service ${key}`) } catch (error) { log(`could not close ${key}: ${error.message}`) }
    }
    // Forget deadlines for services that were closed some other way (CLI, sandbox deleted).
    if (Object.keys(deadlines).length) {
      const open = new Set((await listServices()).map((s) => keyOf(s.sandbox, s.name)))
      const current = await readDeadlines()
      let changed = false
      for (const key of Object.keys(current)) if (!open.has(key)) { delete current[key]; changed = true }
      if (changed) await writeDeadlines(current)
    }
  } catch { /* Gateway unreachable; try again on the next tick. */ } finally {
    sweeping = false
  }
}

export function startSweeper(log) {
  sweep(log)
  const timer = setInterval(() => sweep(log), 30000)
  timer.unref?.()
  return () => clearInterval(timer)
}

export async function ingressRoute(method, parts, input) {
  if (parts[0] !== 'ingress') return undefined
  if (method === 'GET' && parts.length === 1) return ingressOverview()
  if (method !== 'POST') return undefined
  if (parts[1] === 'expose') return expose(input)
  if (parts[1] === 'close') return close(input)
  if (parts[1] === 'extend') return extend(input)
  return undefined
}
