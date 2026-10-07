import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { gateway, iso, contextKey, contextSelection, runWithContext } from './gateway.js'
import { stateDirectory } from './paths.js'
import { assertCloudOperation } from './security.js'

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
const stateFile = () => path.join(stateDirectory(), 'ingress.json')
const MAX_MINUTES = 7 * 24 * 60

const keyOf = (sandbox, name) => JSON.stringify([contextKey(), sandbox, name])

async function readDeadlines() {
  try { return JSON.parse(await fs.readFile(stateFile(), 'utf8')) } catch (error) { if (error.code === 'ENOENT') return {}; throw error }
}
async function writeDeadlines(deadlines) {
  await fs.mkdir(path.dirname(stateFile()), { recursive: true })
  await fs.writeFile(stateFile(), `${JSON.stringify(deadlines, null, 2)}\n`)
}

let deadlineWrite = Promise.resolve()
function updateDeadlines(change) {
  const pending = deadlineWrite.then(async () => {
    const deadlines = await readDeadlines()
    change(deadlines)
    await writeDeadlines(deadlines)
  })
  deadlineWrite = pending.catch(() => {})
  return pending
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
  const { client, workspaceScope } = await gateway()
  const [response, deadlines] = await Promise.all([
    client.raw.listServices({ workspaceScope: workspaceScope, pageSize: 1000 }),
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
  const key = keyOf(sandbox, name)
  const context = contextSelection()
  await updateDeadlines((deadlines) => {
    if (expiresAt) deadlines[key] = { expiresAt, context, sandbox, name }
    else delete deadlines[key]
  })
}

export async function expose({ sandbox, name = '', port, closeAfterMinutes }) {
  assertCloudOperation(['ingress', 'expose'])
  if (!SANDBOX.test(sandbox ?? '')) throw fail('Unknown sandbox.')
  if (!SERVICE.test(name)) throw fail('Service names use lowercase letters, digits and dashes (up to 32).')
  const targetPort = Number(port)
  if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) throw fail('Ports are 1–65535.')
  const expiresAt = deadlineFrom(closeAfterMinutes)
  const { client, workspaceScope } = await gateway()
  const response = await client.raw.exposeService({ sandbox, name, targetPort, domain: true, workspaceScope: workspaceScope, requestId: randomUUID() })
  await setDeadline(sandbox, name, expiresAt)
  return { url: response.url || null, expiresAt }
}

export async function close({ sandbox, name = '' }, reason = 'closed') {
  if (!SANDBOX.test(sandbox ?? '') || !SERVICE.test(name)) throw fail('Unknown service.')
  const { client, workspaceScope } = await gateway()
  await client.raw.deleteService({ sandbox, name, allowMissing: true, workspaceScope: workspaceScope, requestId: randomUUID() })
  await setDeadline(sandbox, name, null)
  return { ok: true, reason }
}

async function extend({ sandbox, name = '', closeAfterMinutes }) {
  assertCloudOperation(['ingress', 'extend'])
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
  const [services, sessions] = await Promise.all([listServices(), target.remote ? { file: null, ttlSeconds: null } : sessionPolicy()])
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
    const due = Object.entries(deadlines).filter(([, d]) => d.context && Date.parse(d.expiresAt) <= now)
    for (const [key, deadline] of due) {
      try {
        await runWithContext(deadline.context, () => close(deadline, 'expired'))
        log(`closed expired service ${key}`)
      } catch (error) { log(`could not close ${key}: ${error.message}`) }
    }
    // Read each recorded context independently; never prune another gateway's deadlines.
    const contexts = new Map(Object.values(deadlines).filter((d) => d.context).map((d) => [contextKey(d.context), d.context]))
    for (const [scope, context] of contexts) {
      try {
        await runWithContext(context, async () => {
          const open = new Set((await listServices()).map((s) => keyOf(s.sandbox, s.name)))
          await updateDeadlines((current) => {
            for (const [key, value] of Object.entries(current)) {
              if (value.context && contextKey(value.context) === scope && !open.has(key) && value.expiresAt === deadlines[key]?.expiresAt) delete current[key]
            }
          })
        })
      } catch { /* An unreachable gateway keeps its own deadlines for the next pass. */ }
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
