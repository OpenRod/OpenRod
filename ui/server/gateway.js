import { createHash } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { OpenShellClient } from '@nvidia/openshell-sdk'

// Gateway credentials stay in the server process. Browser clients may select
// only registrations that already exist in the OpenShell CLI config.
export const CONFIG_DIR = path.join(process.env.XDG_CONFIG_HOME ?? (process.platform === 'win32' && process.env.APPDATA ? process.env.APPDATA : path.join(process.env.HOME || os.homedir(), '.config')), 'openshell')
const CONTEXT_FILE = path.join(CONFIG_DIR, 'console-context.json')
const GATEWAY_NAME = /^(?!\.{1,2}$)[\w.-]{1,64}$/
const WORKSPACE_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

function activeGateway() {
  try { return fs.readFileSync(path.join(CONFIG_DIR, 'active_gateway'), 'utf8').trim() || null } catch { return null }
}

function savedContext() {
  try {
    const value = JSON.parse(fs.readFileSync(CONTEXT_FILE, 'utf8'))
    return GATEWAY_NAME.test(value.gateway ?? '') && WORKSPACE_NAME.test(value.workspace ?? '') ? value : {}
  } catch { return {} }
}

const saved = savedContext()
const cliGateway = activeGateway()
let selected = {
  gateway: process.env.OPENSHELL_GATEWAY || saved.gateway || cliGateway || 'openshell',
  workspace: process.env.OPENSHELL_WORKSPACE || saved.workspace || 'default',
}
let configured = Boolean(process.env.OPENSHELL_GATEWAY || saved.gateway)
let selectionSource = process.env.OPENSHELL_GATEWAY ? 'environment' : saved.gateway ? 'saved' : cliGateway ? 'cli' : 'default'
export const contextConfigured = () => configured
// A console nobody has pointed anywhere yet: no saved or cleared choice and no
// OPENSHELL_GATEWAY. Its candidate is the gateway the OpenShell CLI is set to.
export const unchosenCliGateway = () => !configured && !process.env.OPENSHELL_GATEWAY && cliGateway && !fs.existsSync(CONTEXT_FILE) ? cliGateway : null

const requestContext = new AsyncLocalStorage()
export const contextSelection = () => ({ ...(requestContext.getStore() ?? selected) })
export const defaultContextSelection = () => ({ ...selected })
export const contextKey = (context = contextSelection()) => JSON.stringify([context.gateway ?? context.target?.name, context.workspace])
export const runWithContext = (context, task) => requestContext.run(Object.freeze({ gateway: context.gateway ?? context.target?.name, workspace: context.workspace }), task)

function readGatewayMetadata(name, configDir = CONFIG_DIR) {
  if (!GATEWAY_NAME.test(name)) throw new Error('INVALID_GATEWAY_NAME')
  const metadata = JSON.parse(fs.readFileSync(path.join(configDir, 'gateways', name, 'metadata.json'), 'utf8'))
  const endpoint = new URL(metadata.gateway_endpoint)
  if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || typeof metadata.auth_mode !== 'string') {
    throw new Error('Invalid gateway registration. Use an endpoint without embedded credentials.')
  }
  return {
    name,
    endpoint: metadata.gateway_endpoint,
    authMode: metadata.auth_mode,
    remote: Boolean(metadata.is_remote),
  }
}

export function resolveGateway(name = contextSelection().gateway, { configDir = CONFIG_DIR } = {}) {
  const target = readGatewayMetadata(name, configDir)
  const mtls = path.join(configDir, 'gateways', name, 'mtls')
  const read = (file) => fs.readFileSync(path.join(mtls, file))
  return {
    ...target,
    tls: target.authMode === 'mtls'
      ? { caCert: read('ca.crt'), clientCert: read('tls.crt'), clientKey: read('tls.key') }
      : {},
  }
}

// Unary requests must release policy queues when the gateway stalls. A finite
// command also bounds its transport; watches and interactive terminals retain
// their caller-controlled lifetime. Explicit RPC timeouts are preserved.
export async function connectGateway(target, { unaryTimeoutMs = 15000, execGraceMs = 5000 } = {}) {
  const client = await OpenShellClient.connect({ gateway: target.endpoint, ...target.tls })
  const transport = client.transport
  const unary = transport.unary.bind(transport), stream = transport.stream.bind(transport)
  transport.unary = (method, signal, timeoutMs, ...rest) => unary(method, signal, timeoutMs === undefined ? unaryTimeoutMs : timeoutMs, ...rest)
  transport.stream = async (method, signal, timeoutMs, header, input, contextValues) => {
    if (timeoutMs !== undefined || method.name !== 'ExecSandbox') return stream(method, signal, timeoutMs, header, input, contextValues)
    // ExecSandbox is server-streaming: its first (only) request carries the
    // execution timeout. Replay it intact before delegating to the transport.
    const iterator = input[Symbol.asyncIterator](), first = await iterator.next()
    const duration = first.value?.executionTimeout
    const executionMs = Number(duration?.seconds ?? 0) * 1000 + Number(duration?.nanos ?? 0) / 1e6
    const bounded = Number.isFinite(executionMs) && executionMs > 0 ? executionMs + execGraceMs : undefined
    const replay = {
      async *[Symbol.asyncIterator]() {
        if (!first.done) { yield first.value; yield* { [Symbol.asyncIterator]: () => iterator } }
      },
    }
    return stream(method, signal, bounded, header, replay, contextValues)
  }
  return client
}

export function listGateways({ configDir = CONFIG_DIR } = {}) {
  let entries
  try { entries = fs.readdirSync(path.join(configDir, 'gateways'), { withFileTypes: true }) } catch { return [] }
  return entries
    .filter((entry) => entry.isDirectory() && GATEWAY_NAME.test(entry.name))
    .flatMap((entry) => {
      try {
        const target = readGatewayMetadata(entry.name, configDir)
        return [{ ...target, supported: target.authMode === 'mtls' }]
      } catch {
        return [{ name: entry.name, endpoint: null, authMode: null, remote: false, supported: false, error: 'Registration could not be read. Check its metadata.json file.' }]
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

// mTLS gateways registered on this computer, the ones "Use this computer" can pick.
export const localGateways = (options) => listGateways(options).filter(target => target.name !== 'aws-eks' && target.supported && !target.remote && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(target.endpoint).hostname))

export const workspaceScope = (workspace = workspaceName()) => ({ selection: { case: 'workspace', value: workspace } })
export const workspaceName = () => contextSelection().workspace

const connections = new Map()
async function connectRegisteredGateway(name) {
  const target = resolveGateway(name)
  if (target.authMode !== 'mtls') throw new Error(`Gateway authentication mode "${target.authMode}" is not supported yet.`)
  if (new URL(target.endpoint).protocol !== 'https:') throw new Error('mTLS requires an HTTPS gateway endpoint.')
  // Registration and certificate changes take effect without a restart.
  const fingerprint = createHash('sha256').update(target.endpoint)
    .update(target.tls.caCert).update(target.tls.clientCert).update(target.tls.clientKey).digest('hex')
  if (connections.get(name)?.fingerprint !== fingerprint) {
    const ready = (async () => {
      const client = await connectGateway(target)
      return { target, client }
    })()
    connections.set(name, { fingerprint, ready })
  }
  const entry = connections.get(name)
  try { return await entry.ready } catch (error) {
    if (connections.get(name) === entry) connections.delete(name)
    throw error
  }
}
// A restarted gateway gets a fresh connection on the next call.
export const forgetGatewayConnection = (name) => { connections.delete(name) }

async function listWorkspaces(client) {
  const workspaces = []
  let pageToken = ''
  do {
    const page = await client.raw.listWorkspaces({ pageSize: 1000, pageToken }, { timeoutMs: 10_000 })
    for (const workspace of page.workspaces ?? []) {
      const name = workspace.metadata?.name
      if (name && WORKSPACE_NAME.test(name)) workspaces.push({ name })
    }
    pageToken = page.nextPageToken
  } while (pageToken)
  return workspaces
}

// Explicit read-only probe: does not select a context or start collectors.
export async function gatewayWorkspaces(name) {
  return listWorkspaces((await connectRegisteredGateway(name)).client)
}

function persistContext(context) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
  const temporary = `${CONTEXT_FILE}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(context, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temporary, CONTEXT_FILE)
}

export async function gateway(context = contextSelection()) {
  const current = { gateway: context.gateway ?? contextSelection().gateway, workspace: context.workspace ?? workspaceName() }
  const connection = await connectRegisteredGateway(current.gateway)
  return { ...connection, workspace: current.workspace, workspaceScope: workspaceScope(current.workspace) }
}

export async function consoleContext({ probe = true } = {}) {
  const current = contextSelection()
  const gateways = listGateways()
  let workspaces = []
  let workspaceError = null
  if (configured && probe) {
    try { workspaces = await gatewayWorkspaces(current.gateway) } catch (error) { workspaceError = error.message }
  }
  return {
    ...current, configured, selectionSource, gateways, workspaces, workspaceError,
    gatewayFixed: Boolean(process.env.OPENSHELL_GATEWAY), workspaceFixed: Boolean(process.env.OPENSHELL_WORKSPACE),
  }
}

export async function selectConsoleContext(input = {}) {
  const previous = selected
  const gatewayName = String(input.gateway ?? previous.gateway)
  if (process.env.OPENSHELL_GATEWAY && gatewayName !== process.env.OPENSHELL_GATEWAY) throw new Error('Gateway selection is fixed by OPENSHELL_GATEWAY.')
  const target = listGateways().find((candidate) => candidate.name === gatewayName)
  if (!target) throw new Error('Unknown gateway registration.')
  if (!target.supported) throw new Error(`Gateway authentication mode "${target.authMode}" is not supported yet.`)
  const client = (await connectRegisteredGateway(gatewayName)).client
  const workspaces = await listWorkspaces(client)
  const requestedWorkspace = String(input.workspace ?? process.env.OPENSHELL_WORKSPACE ?? (gatewayName === previous.gateway ? previous.workspace : 'default'))
  if (process.env.OPENSHELL_WORKSPACE && requestedWorkspace !== process.env.OPENSHELL_WORKSPACE) throw new Error('Workspace selection is fixed by OPENSHELL_WORKSPACE.')
  if (!WORKSPACE_NAME.test(requestedWorkspace) || !workspaces.some((workspace) => workspace.name === requestedWorkspace)) throw new Error('Unknown workspace.')
  if (previous !== selected) throw Object.assign(new Error('The connection changed in another request. Refresh and try again.'), { status: 409 })
  const next = { gateway: gatewayName, workspace: requestedWorkspace }
  persistContext(next)
  selected = next
  configured = true
  selectionSource = process.env.OPENSHELL_GATEWAY ? 'environment' : 'saved'
  return {
    ...selected, configured, selectionSource, gateways: listGateways(), workspaces, workspaceError: null,
    gatewayFixed: Boolean(process.env.OPENSHELL_GATEWAY), workspaceFixed: Boolean(process.env.OPENSHELL_WORKSPACE),
  }
}

export function clearConsoleContext() {
  if (process.env.OPENSHELL_GATEWAY) throw new Error('Gateway selection is fixed by OPENSHELL_GATEWAY.')
  persistContext({})
  selected = { gateway: cliGateway || 'openshell', workspace: process.env.OPENSHELL_WORKSPACE || 'default' }
  configured = false
  selectionSource = cliGateway ? 'cli' : 'default'
}

// ---- normalization: protobuf wire shapes → small, browser-safe JSON ---------

const PHASES = ['unspecified', 'provisioning', 'ready', 'error', 'deleting', 'unknown', 'stopping', 'stopped', 'starting', 'completed']
const ACCESS = ['', 'read-only', 'read-write', 'full']

export const iso = (ts) => (ts && ts.seconds !== undefined
  ? new Date(Number(ts.seconds) * 1000 + Math.floor((ts.nanos ?? 0) / 1e6)).toISOString()
  : null)

export function sandboxView(sandbox) {
  const meta = sandbox.metadata ?? {}
  const spec = sandbox.spec ?? {}
  const status = sandbox.status ?? {}
  const conditions = (status.conditions ?? []).map(({ type, status: state, reason, message }) => ({ type, status: state, reason, message }))
  return {
    id: meta.id,
    name: meta.name,
    workspace: meta.workspace,
    createdAt: iso(meta.createdTime),
    phase: PHASES[status.phase] ?? 'unknown',
    image: spec.template?.image || null,
    // The gateway's own record of the template a sandbox was created from.
    workloadTemplate: sandbox.createdFromWorkloadTemplate?.name || null,
    providers: spec.providers ?? [],
    command: spec.command ?? [],
    tty: Boolean(spec.tty),
    labels: meta.labels ?? {},
    policyVersion: status.currentPolicyVersion ?? null,
    conditions,
    // The one sentence worth showing when something is wrong.
    problem: conditions.find((c) => ['Ready', 'ConfigurationReady', 'PodScheduled'].includes(c.type) && c.status === 'False' && c.message)?.message ?? null,
  }
}

// An egress block: an endpoint whose deny rules match every request.
const blocksAll = (e) => (e.denyRules ?? []).some((r) => (r.method || '*') === '*' && r.path === '/**')

export function policyView(policy) {
  if (!policy) return null
  const rules = Object.entries(policy.networkPolicies ?? {}).map(([key, rule]) => ({
    key,
    name: rule.name || key,
    fromProvider: key.startsWith('_provider_'),
    binaries: (rule.binaries ?? []).map((b) => b.path),
    endpoints: (rule.endpoints ?? []).map((e) => ({
      blocked: blocksAll(e),
      host: e.host,
      port: e.port || e.ports?.[0] || null,
      ports: e.ports?.length ? e.ports : e.port ? [e.port] : [],
      path: e.path || null,
      protocol: e.protocol || 'tcp',
      access: blocksAll(e) ? 'blocked' : ACCESS[e.access] || (e.rules?.length ? 'custom' : e.protocol && e.protocol !== 'tcp' ? 'none' : 'connect'),
      // UNSPECIFIED is not "enforce": the gateway treats an unset mode as audit,
      // which logs violations and lets them through.
      enforcement: e.enforcement === 1 ? 'enforce' : 'audit',
      enforcementUnset: !e.enforcement,
      allow: (e.rules ?? []).map((r) => ({ method: r.allow?.method || '*', path: r.allow?.path || '', command: r.allow?.command || null })),
      deny: (e.denyRules ?? []).map((r) => ({ method: r.method || '*', path: r.path || '', command: r.command || null })),
      allowedIps: e.allowedIps ?? [],
      tlsSkip: e.tls === 1,
      credentialRisk: Boolean(e.allowUninspectedCredentials || e.tls === 1),
    })),
  }))
  return {
    filesystem: {
      workdir: Boolean(policy.filesystem?.includeWorkdir),
      readOnly: policy.filesystem?.readOnly ?? [],
      readWrite: policy.filesystem?.readWrite ?? [],
    },
    landlock: policy.landlock?.compatibility || null,
    process: { runAsUser: policy.process?.runAsUser || null, runAsGroup: policy.process?.runAsGroup || null },
    rules,
  }
}

export function chunkView(sandbox, chunk) {
  const rule = chunk.proposedRule ?? {}
  return {
    sandbox,
    id: chunk.id,
    status: chunk.status,
    ruleName: chunk.ruleName,
    rationale: chunk.rationale,
    securityNotes: chunk.securityNotes || null,
    confidence: chunk.confidence ?? 0,
    hitCount: chunk.hitCount ?? 0,
    binary: chunk.binary || rule.binaries?.[0]?.path || null,
    prover: chunk.validationResult || null,
    rejectionReason: chunk.rejectionReason || null,
    applicationError: chunk.applicationError || null,
    reviewToken: chunk.reviewToken,
    createdAt: iso(chunk.createdTime),
    decidedAt: iso(chunk.decidedTime),
    lastSeenAt: iso(chunk.lastSeenTime),
    endpoints: (rule.endpoints ?? []).map((e) => ({ host: e.host, port: e.port || e.ports?.[0] || null })),
  }
}

// OCSF shorthand lines are the sandbox's audit trail, e.g.
//   NET:OPEN [MED] DENIED /usr/local/bin/claude(0) -> api.example.com:443 [reason:...]
//   HTTP:POST [INFO] ALLOWED POST http://api.anthropic.com:443/v1/messages [policy:_provider_x engine:l7]
const OCSF = /^(NET|HTTP|SSH|FINDING|CONFIG|PROC|FILE|AUTH|EVENT)(?::(\S+))?\s+\[(\w+)\]\s*(ALLOWED|DENIED|BLOCKED)?\s*(.*)$/
export function logView(sandbox, line) {
  const original = JSON.parse(JSON.stringify(line, (_, value) => typeof value === 'bigint' ? value.toString() : value))
  const base = {
    id: createHash('sha256').update(JSON.stringify([sandbox, original])).digest('hex'),
    idSource: 'Fingerprint of source envelope; source event ID unavailable',
    original,
    sandbox,
    at: iso(line.eventTime),
    level: line.level,
    source: line.source,
    target: line.target,
    message: line.message,
    action: line.fields?.action || null,
    destination: line.fields?.destination || null,
    reason: line.fields?.reason || null,
  }
  // Someone ran a command in the sandbox (exec, connect's shell, an SDK call).
  if (line.target === 'openshell_server::grpc::sandbox' && /^ExecSandbox\b.*command started/.test(line.message)) {
    return { ...base, kind: 'inbound', type: 'command', category: 'PROC', action: 'EXEC', outcome: 'unknown', verdict: null, detail: 'Command run in the sandbox' }
  }
  if (line.level !== 'OCSF') return { ...base, kind: 'log' }
  const match = OCSF.exec(line.message)
  if (!match) return { ...base, kind: 'event' }
  const inbound = inboundView(base, match)
  if (inbound) return inbound
  const [, category, action, severity, verdict, rest] = match
  // Tags trail the line. A reason is free text and may itself contain brackets
  // ("policy changed [captured_generation:1 ...]"), so it runs to the last `]`.
  const reason = /\[reason:(.*)\]\s*$/s.exec(rest)?.[1] ?? null
  const policy = /\[policy:(\S+?)[\s\]]/.exec(rest)?.[1] ?? null
  const body = rest.replace(/\s*\[(?:reason|policy|engine)[^]*$/s, '').trim()
  let binary = null, destination = null, method = null
  if (category === 'NET') {
    const net = /^(\S+?)(?:\(\d+\))?\s*->\s*(\S+)/.exec(body)
    if (net) { binary = net[1]; destination = net[2] }
    else if (body) destination = body.split(/\s+/)[0]
  } else if (category === 'HTTP') {
    const http = /^(\w+)\s+(\S+)/.exec(body)
    if (http) {
      method = http[1]
      destination = http[2]
    }
  }
  return {
    ...base,
    kind: 'audit',
    category,
    action: action ?? null,
    severity,
    direction: ['NET', 'HTTP'].includes(category) ? 'out' : 'unknown',
    outcome: action === 'FAIL' ? 'failure' : 'unknown',
    verdict: verdict === 'ALLOWED' ? 'allowed' : verdict ? 'denied' : null,
    binary, destination, method,
    policy,
    reason,
    detail: body,
  }
}

// Traffic coming *into* the sandbox. Kept out of the egress trail: a refused
// visit to an exposed service is not the sandbox reaching out, and counting it
// as an outbound denial would put ingress noise in Egress.
//   CONFIG:SERVICE_ENDPOINT_CREATED [INFO] Service endpoint exposed sb/web -> 127.0.0.1:8080
//   NET:OPEN [LOW] DENIED 127.0.0.1:8080 [policy:sandbox_service_relay ...] [reason:service endpoint unreachable]
//   NET:OPEN [INFO] 127.0.0.1:8080/tcp            (a visit arriving inside the sandbox)
//   SSH:OPEN [INFO] ALLOWED                        (a terminal or exec session)
const INTERNAL_PORTS = new Set(['3128', '17670'])
function inboundView(base, [, category, action, severity, verdict, rest]) {
  const common = { ...base, kind: 'inbound', category, action: action ?? null, severity, direction: ['NET', 'HTTP', 'SSH'].includes(category) ? 'in' : 'unknown', outcome: action === 'FAIL' ? 'failure' : 'unknown' }
  if (category === 'CONFIG' && /^SERVICE_ENDPOINT_/.test(action ?? '')) {
    const m = /exposed\s+(\S+?)(?:\/(\S+))?\s+->\s+\S+:(\d+)/.exec(rest) ?? /(\S+?)(?:\/(\S+))?\s*(?:->\s*\S+:(\d+))?$/.exec(rest)
    return { ...common, type: /CREATED|EXPOSED|UPDATED/.test(action) ? 'service-opened' : 'service-closed', verdict: null, service: m?.[2] ?? '', port: m?.[3] ? Number(m[3]) : null, detail: rest.trim() }
  }
  if (category === 'SSH' && action === 'OPEN') {
    return { ...common, type: 'session', verdict: verdict === 'ALLOWED' ? 'allowed' : verdict ? 'denied' : null, detail: 'Terminal session opened' }
  }
  if (category === 'NET' && /\[policy:sandbox_service_relay\b/.test(rest)) {
    const port = Number(/127\.0\.0\.1:(\d+)/.exec(rest)?.[1]) || null
    const reason = /\[reason:([^\]]*)\]/.exec(rest)?.[1] ?? null
    return { ...common, type: 'visit', verdict: verdict === 'ALLOWED' ? 'allowed' : verdict ? 'denied' : null, port, reason, detail: reason ?? 'Visit to an exposed service' }
  }
  if (category === 'NET' && (action === 'OPEN' || action === 'FAIL') && base.source === 'sandbox') {
    const m = /^127\.0\.0\.1:(\d+)\/tcp\b/.exec(rest.trim())
    if (m && !INTERNAL_PORTS.has(m[1])) {
      return { ...common, type: 'visit', verdict: verdict === 'ALLOWED' ? 'allowed' : verdict ? 'denied' : null, port: Number(m[1]), reason: action === 'FAIL' ? 'nothing listening on that port' : null, detail: `Connection into port ${m[1]}` }
    }
  }
  return null
}

// Stored credentials are reported by key name only; the gateway already
// redacts values, and this view drops them entirely rather than relay "REDACTED".
export function providerView(provider) {
  return {
    name: provider.metadata?.name,
    type: provider.type,
    credentialKeys: Object.keys(provider.credentials ?? {}),
    configKeys: Object.keys(provider.config ?? {}),
  }
}
