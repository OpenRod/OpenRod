import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { OpenShellClient } from '@nvidia/openshell-sdk'

// The same gateway the `openshell` CLI talks to: its active selection, its
// endpoint, and its mTLS client bundle. The bundle is the operator's full
// authority over the gateway, so it is read here and never leaves this process.
const CONFIG_DIR = process.env.OPENSHELL_CONFIG_DIR ?? path.join(os.homedir(), '.config/openshell')

export function resolveGateway() {
  let name = process.env.OPENSHELL_GATEWAY
  if (!name) {
    try { name = fs.readFileSync(path.join(CONFIG_DIR, 'active_gateway'), 'utf8').trim() } catch { name = 'openshell' }
  }
  if (!/^[\w.-]{1,64}$/.test(name)) throw new Error('INVALID_GATEWAY_NAME')
  const dir = path.join(CONFIG_DIR, 'gateways', name)
  const metadata = JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json'), 'utf8'))
  const mtls = path.join(dir, 'mtls')
  const read = (file) => fs.readFileSync(path.join(mtls, file))
  return {
    name,
    endpoint: metadata.gateway_endpoint,
    authMode: metadata.auth_mode,
    remote: Boolean(metadata.is_remote),
    tls: metadata.auth_mode === 'mtls'
      ? { caCert: read('ca.crt'), clientCert: read('tls.crt'), clientKey: read('tls.key') }
      : {},
  }
}

let cached
export async function gateway() {
  if (!cached) {
    const target = resolveGateway()
    const client = await OpenShellClient.connect({ gateway: target.endpoint, ...target.tls })
    cached = { target, client }
  }
  return cached
}

export const WORKSPACE = { selection: { case: 'workspace', value: 'default' } }

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
    problem: conditions.find((c) => c.status === 'False' && c.message)?.message ?? null,
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
