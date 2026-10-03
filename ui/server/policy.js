import { createTemplateStore } from './policy-template-store.js'
import { BUILTIN_TEMPLATES, normalizeAccessTemplates } from '../shared/policy-templates.js'
export { BUILTIN_TEMPLATES } from '../shared/policy-templates.js'
import { validateSecretCredentials } from '../shared/secret-fields.js'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { gateway, iso, policyView, providerView, sandboxView } from './gateway.js'
import { policyDirectory } from './paths.js'
import { blockedBy, isManaged, managedOpsFor, readOrg, serializeOrgWrite } from './org.js'

const exec = promisify(execFile)
const fail = (message, status = 400) => Object.assign(new Error(message), { status })

// ---- rule specs: the console's own small JSON shape → proto ---------------
//
// A rule is { name, binaries: [path], endpoints: [{ host, ports, protocol,
// access | allow/deny, enforcement, allowedIps }] }. It is validated here
// rather than trusted from the browser, and the gateway validates it again.

const RULE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/
const HOST = /^(\*\*?\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i
const BINARY = /^\/[\w.+@*?/[\]-]{1,255}$/
const PROTOCOLS = ['tcp', 'rest', 'websocket', 'graphql', 'mcp', 'json-rpc']
const L7_PROTOCOLS = PROTOCOLS.filter((p) => p !== 'tcp')
const ACCESS = { 'read-only': 1, 'read-write': 2, full: 3 }
const METHODS = ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE', '*']
const CIDR = /^[0-9a-f:.]+(\/\d{1,3})?$/i

function l7Match(input, where) {
  const method = String(input.method ?? '').toUpperCase()
  const pathGlob = String(input.path ?? '')
  if (!METHODS.includes(method)) throw fail(`${where}: unsupported method "${input.method}".`)
  if (!pathGlob.startsWith('/') || pathGlob.length > 512) throw fail(`${where}: a path must start with "/".`)
  return { method, path: pathGlob }
}

export function ruleToProto(spec) {
  const name = String(spec.name ?? '').trim()
  if (!RULE_NAME.test(name)) throw fail('Rule names use lowercase letters, digits, "-" and "_".')
  if (name.startsWith('_provider_')) throw fail('Names starting with _provider_ are reserved for secrets.')
  const binaries = (spec.binaries ?? []).map(String)
  if (!binaries.length) throw fail('Choose at least one program. A rule with no programs matches nothing.')
  for (const b of binaries) if (!BINARY.test(b)) throw fail(`"${b}" is not an absolute program path.`)
  const endpoints = (spec.endpoints ?? []).map((e, i) => {
    const where = `Destination ${i + 1}`
    const host = String(e.host ?? '').trim().toLowerCase()
    if (!HOST.test(host)) throw fail(`${where}: "${e.host}" is not a host name (wildcards: *.example.com or **.example.com).`)
    const ports = (e.ports ?? []).map(Number)
    if (!ports.length || ports.some((p) => !Number.isInteger(p) || p < 1 || p > 65535)) throw fail(`${where}: ports must be 1–65535.`)
    const protocol = e.protocol ?? 'tcp'
    if (!PROTOCOLS.includes(protocol)) throw fail(`${where}: unknown protocol.`)
    const allow = (e.allow ?? []).map((r) => l7Match(r, where))
    const deny = (e.deny ?? []).map((r) => l7Match(r, where))
    const access = e.access && !allow.length ? ACCESS[e.access] : 0
    if (protocol === 'tcp' && (allow.length || deny.length || access)) throw fail(`${where}: plain TCP cannot inspect requests. Pick an HTTP protocol to add request rules.`)
    if (e.tlsSkip && protocol !== 'tcp') throw fail(`${where}: TLS passthrough requires plain TCP without request inspection.`)
    if (L7_PROTOCOLS.includes(protocol) && !access && !allow.length) throw fail(`${where}: choose an access level or add at least one allowed request.`)
    const allowedIps = (e.allowedIps ?? []).map(String).filter(Boolean)
    for (const ip of allowedIps) if (!CIDR.test(ip)) throw fail(`${where}: "${ip}" is not an IP or CIDR.`)
    return {
      host,
      ...(ports.length === 1 ? { port: ports[0] } : { ports }),
      protocol: protocol === 'tcp' ? '' : protocol,
      ...(e.tlsSkip ? { tls: 1 } : {}),
      enforcement: e.enforcement === 'audit' ? 2 : 1,
      access,
      rules: allow.map((a) => ({ allow: a })),
      denyRules: deny,
      allowedIps,
    }
  })
  if (!endpoints.length) throw fail('Add at least one destination.')
  return { name, rule: { name, endpoints, binaries: binaries.map((p) => ({ path: p })) } }
}

// ---- sandbox policy ---------------------------------------------------------

const REVISION_STATUS = ['unspecified', 'pending', 'loaded', 'failed', 'superseded']
const SOURCE = ['unspecified', 'sandbox', 'global']

function revisionView(r) {
  return {
    version: r.version,
    hash: r.policyHash,
    status: REVISION_STATUS[r.status] ?? 'unspecified',
    loadError: r.loadError || null,
    createdAt: iso(r.createdTime),
    loadedAt: iso(r.loadedTime),
    provenance: r.provenance ?? {},
  }
}

async function policyOf(sandbox) {
  const { client, workspaceScope } = await gateway()
  const [status, config, list] = await Promise.all([
    client.raw.getSandboxPolicyStatus({ sandbox, workspaceScope: workspaceScope }),
    client.raw.getSandboxConfig({ name: sandbox, workspaceScope: workspaceScope }),
    client.raw.listSandboxPolicies({ sandbox, workspaceScope: workspaceScope, pageSize: 50 }),
  ])
  return {
    sandbox,
    source: SOURCE[config.policySource] ?? 'sandbox',
    activeVersion: status.activeVersion,
    latest: status.revision ? revisionView(status.revision) : null,
    // Base: what this console edits. Effective: base + one rule per attached secret.
    base: policyView(status.revision?.policy),
    effective: policyView(config.policy),
    admitted: config.configurationAdmitted,
    configurationError: config.configurationError || null,
    failureMode: config.policyValidationFailureMode || null,
    globalPolicyVersion: config.globalPolicyVersion || 0,
    revisions: list.revisions.map(revisionView),
  }
}

// Every sandbox's effective rules in one reading, for the fleet summary.
async function fleet() {
  const { client, workspaceScope } = await gateway()
  const list = await client.raw.listSandboxes({ workspaceScope: workspaceScope })
  const sandboxes = list.sandboxes.map(sandboxView).filter((s) => s.phase !== 'deleting')
  const rows = await Promise.all(sandboxes.map(async (s) => {
    try {
      const [config, status] = await Promise.all([
        client.raw.getSandboxConfig({ name: s.name, workspaceScope: workspaceScope }),
        client.raw.getSandboxPolicyStatus({ sandbox: s.name, workspaceScope: workspaceScope }),
      ])
      return {
        name: s.name, phase: s.phase, labels: s.labels,
        source: SOURCE[config.policySource] ?? 'sandbox',
        version: status.revision?.version ?? null,
        status: status.revision ? REVISION_STATUS[status.revision.status] ?? 'unspecified' : null,
        rules: policyView(config.policy)?.rules ?? [],
      }
    } catch (error) {
      return { name: s.name, phase: s.phase, labels: s.labels, error: error.rawMessage ?? error.message, rules: [] }
    }
  }))
  return { sandboxes: rows }
}

async function revisionPolicy(sandbox, version) {
  const { client, workspaceScope } = await gateway()
  const status = await client.raw.getSandboxPolicyStatus({ sandbox, version, workspaceScope: workspaceScope })
  return { revision: revisionView(status.revision), policy: status.revision.policy }
}

// UI operations → the gateway's server-side patch operations. Each targets
// the base policy; the gateway rejects anything that would not validate.
function mergeOp(op) {
  const ruleName = String(op.ruleName ?? '')
  if (op.kind !== 'addRule' && !RULE_NAME.test(ruleName)) throw fail('Unknown rule.')
  // Policy and organization rules are changed where they are defined, so one
  // sandbox cannot drift from the policies that apply to it.
  const target = op.kind === 'addRule' ? String(op.rule?.name ?? '') : ruleName
  if (isManaged(target)) throw fail('This rule comes from a network rule or the organization. Change it on the Network page.', 403)
  switch (op.kind) {
    case 'addRule': {
      const { name, rule } = ruleToProto(op.rule)
      return { operation: { case: 'addRule', value: { ruleName: name, rule } } }
    }
    case 'removeRule':
      return { operation: { case: 'removeRule', value: { ruleName } } }
    case 'removeEndpoint': {
      const host = String(op.host ?? '')
      if (!HOST.test(host)) throw fail('Unknown destination.')
      return { operation: { case: 'removeEndpoint', value: { ruleName, host, port: Number(op.port) || 0 } } }
    }
    case 'removeBinary':
      if (!BINARY.test(String(op.binary))) throw fail('Unknown program.')
      return { operation: { case: 'removeBinary', value: { ruleName, binaryPath: op.binary } } }
    case 'addAllow':
    case 'addDeny': {
      const host = String(op.host ?? '')
      const ports = (op.ports ?? []).map(Number)
      const binaries = (op.binaries ?? []).map(String)
      if (!HOST.test(host) || !ports.length || !binaries.length) throw fail('Unknown destination.')
      const match = l7Match(op.match ?? {}, 'Request rule')
      // The gateway requires the rule's complete program list, so a new
      // permission can never quietly reach a program the operator didn't name.
      const target = { ruleName, host, ports, binaries: binaries.map((p) => ({ path: p })) }
      return op.kind === 'addAllow'
        ? { operation: { case: 'addAllowRules', value: { target, rules: [{ allow: match }] } } }
        : { operation: { case: 'addDenyRules', value: { target, denyRules: [match] } } }
    }
    default:
      throw fail('Unknown operation.')
  }
}

function applyOps(sandbox, ops) {
  return serializeOrgWrite(() => applyOpsWhileLocked(sandbox, ops))
}

async function applyOpsWhileLocked(sandbox, ops) {
  if (!Array.isArray(ops) || !ops.length || ops.length > 20) throw fail('Nothing to apply.')
  const org = await readOrg()
  for (const op of ops) {
    const hosts = op.kind === 'addRule' ? (op.rule?.endpoints ?? []).map((e) => e.host) : op.kind === 'addAllow' ? [op.host] : []
    const hit = blockedBy(org, hosts)
    if (hit) throw fail(`${hit.host} is blocked by organization policy (${hit.pattern}).`, 403)
  }
  const { client, target, workspaceScope } = await gateway()
  // A block covers every port the sandbox opens, so a rule that opens a new
  // port takes the recomputed blocks along in the same revision.
  const opened = ops.flatMap((op) => (op.kind === 'addRule' ? (op.rule?.endpoints ?? []).flatMap((e) => e.ports ?? []) : ['addAllow', 'addDeny'].includes(op.kind) ? op.ports ?? [] : [])).map(Number)
  const managed = opened.some((p) => ![443, 80].includes(p)) ? await managedOpsFor(client, workspaceScope, sandbox, opened, target.endpoint) : []
  const response = await client.raw.updateConfig({
    sandbox, workspaceScope: workspaceScope, global: false,
    mergeOperations: [...ops.map(mergeOp), ...managed],
    annotations: { 'console.openshell/change': ops.map((o) => `${o.kind}:${o.ruleName ?? o.rule?.name ?? ''}`).join(',').slice(0, 200) },
    requestId: randomUUID(),
  })
  return { version: response.version, hash: response.policyHash }
}

// Restoring sends the old revision's complete policy. Static fields (files,
// landlock, process) are identical across a sandbox's revisions, so only the
// network section actually changes.
async function restore(sandbox, version) {
  const { client, workspaceScope } = await gateway()
  const { policy } = await revisionPolicy(sandbox, version)
  const response = await client.raw.updateConfig({
    sandbox, workspaceScope: workspaceScope, global: false, policy,
    annotations: { 'console.openshell/change': `restore:v${version}` },
    requestId: randomUUID(),
  })
  return { version: response.version, hash: response.policyHash }
}

async function globalPolicy() {
  const { client } = await gateway()
  const list = await client.raw.listSandboxPolicies({ global: true, pageSize: 50 })
  let active = null
  if (list.revisions.length) {
    const status = await client.raw.getSandboxPolicyStatus({ global: true }).catch(() => null)
    active = status?.revision ? { revision: revisionView(status.revision), policy: policyView(status.revision.policy) } : null
  }
  const config = await client.raw.getGatewayConfig({})
  return {
    active: Boolean(active && config.settings?.policy),
    current: active,
    revisions: list.revisions.map(revisionView),
  }
}

async function removeGlobal() {
  const { client } = await gateway()
  await client.raw.updateConfig({ global: true, settingKey: 'policy', deleteSetting: true, requestId: randomUUID() })
  return { ok: true }
}

// ---- guardrail settings -----------------------------------------------------

export const SETTINGS = {
  ocsf_json_enabled: { type: 'bool', default: false },
}

const settingValue = (v) => (v?.value?.case ? v.value.value : null)

async function settings(sandbox) {
  const { client, workspaceScope } = await gateway()
  const globalConfig = await client.raw.getGatewayConfig({})
  const global = Object.fromEntries(Object.keys(SETTINGS).map((key) => [key, settingValue(globalConfig.settings?.[key])]))
  if (!sandbox) return { global }
  const config = await client.raw.getSandboxConfig({ name: sandbox, workspaceScope: workspaceScope })
  const effective = Object.fromEntries(Object.keys(SETTINGS).map((key) => {
    const entry = config.settings?.[key]
    return [key, { value: settingValue(entry?.value), scope: ['default', 'sandbox', 'global'][entry?.scope ?? 0] ?? 'default' }]
  }))
  return { global, sandbox: effective }
}

async function setSetting({ sandbox, key, value, clear }) {
  const spec = SETTINGS[key]
  if (!spec) throw fail('Unknown setting.')
  const { client, workspaceScope } = await gateway()
  const scope = sandbox ? { sandbox, workspaceScope: workspaceScope, global: false } : { global: true }
  if (clear) {
    await client.raw.updateConfig({ ...scope, settingKey: key, deleteSetting: true, requestId: randomUUID() })
    return { ok: true }
  }
  if (spec.type === 'bool' && typeof value !== 'boolean') throw fail('Expected on or off.')
  if (spec.type === 'string' && !spec.values.includes(value)) throw fail('Unsupported value.')
  const settingValue = spec.type === 'bool' ? { value: { case: 'boolValue', value } } : { value: { case: 'stringValue', value } }
  await client.raw.updateConfig({ ...scope, settingKey: key, settingValue, requestId: randomUUID() })
  return { ok: true }
}

// ---- secrets (providers) and profiles --------------------------------------

const CATEGORY = ['unspecified', 'other', 'inference', 'agent', 'source_control', 'messaging', 'data', 'knowledge']
const AUTH_ACCESS = ['', 'read-only', 'read-write', 'full']

function profileView(p) {
  return {
    id: p.id,
    name: p.displayName || p.id,
    description: p.description || null,
    category: CATEGORY[p.category] ?? 'other',
    source: p.source || null,
    scope: p.scope || null,
    credentials: (p.credentials ?? []).map((c) => ({
      name: c.name, description: c.description || null, envVars: c.envVars ?? [], required: Boolean(c.required),
      authStyle: c.authStyle || null, headerName: c.headerName || null, queryParam: c.queryParam || null,
      refresh: c.refresh?.strategy ? true : false,
    })),
    endpoints: (p.endpoints ?? []).map((e) => ({ host: e.host, port: e.port || e.ports?.[0] || null, access: AUTH_ACCESS[e.access] || null, protocol: e.protocol || 'tcp' })),
    binaries: (p.binaries ?? []).map((b) => b.path),
    resourceVersion: p.resourceVersion?.toString?.() ?? null,
  }
}

// NVIDIA's published profiles at the gateway's release. Imported through the
// `openshell` CLI, which already knows how to turn profile YAML into the
// gateway's shape; the console only ever passes one of these fixed URLs.
export const PROFILE_CATALOG = [
  ['claude-code', 'Claude Code', 'agent'], ['codex', 'Codex', 'agent'], ['copilot', 'GitHub Copilot', 'agent'],
  ['openai', 'OpenAI', 'inference'], ['openrouter', 'OpenRouter', 'inference'],
  ['github', 'GitHub', 'source_control'],
].map(([id, name, category]) => ({ id, name, category }))

async function secrets() {
  const { client, target, workspaceScope } = await gateway()
  const [providers, profiles, sandboxes] = await Promise.all([
    client.raw.listProviders({ workspaceScope: workspaceScope, pageSize: 200 }),
    client.raw.listProviderProfiles({ workspaceScope: workspaceScope, pageSize: 200 }),
    client.raw.listSandboxes({ workspaceScope: workspaceScope }),
  ])
  const attached = {}
  for (const s of sandboxes.sandboxes) for (const p of s.spec?.providers ?? []) (attached[p] ??= []).push(s.metadata.name)
  return {
    gateway: target.name,
    providers: providers.providers.map((p) => ({
      ...providerView(p),
      expires: Object.fromEntries(Object.entries(p.credentialExpirationTimes ?? {}).map(([k, t]) => [k, iso(t)])),
      attachedTo: attached[p.metadata?.name] ?? [],
      resourceVersion: p.metadata?.resourceVersion?.toString?.() ?? null,
    })),
    profiles: profiles.profiles.map(profileView),
    catalog: PROFILE_CATALOG,
  }
}

const SECRET_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
const ENV_KEY = /^[A-Z_][A-Z0-9_]{0,127}$/

function credentialMap(input, { allowEmpty = false } = {}) {
  const out = {}
  for (const [key, value] of Object.entries(input ?? {})) {
    if (!ENV_KEY.test(key)) throw fail(`"${key}" is not a valid credential name.`)
    const v = String(value ?? '')
    if (v.length > 8192) throw fail(`${key} is too long.`)
    if (!v && !allowEmpty) continue
    out[key] = v
  }
  return out
}

async function createSecret(input) {
  const { client, workspaceScope, workspace } = await gateway()
  const name = String(input.name ?? '').trim()
  if (!SECRET_NAME.test(name)) throw fail('Use lowercase letters, digits and dashes for the name.')
  const profiles = await client.raw.listProviderProfiles({ workspaceScope: workspaceScope, pageSize: 200 })
  const profile = profiles.profiles.find((p) => p.id === input.type)
  if (!profile) throw fail('Import this profile first.')
  let credentials
  try { credentials = validateSecretCredentials(profile, input.credentials) }
  catch (error) { throw fail(error.message) }
  await client.raw.createProvider({
    workspaceScope: workspaceScope, requestId: randomUUID(),
    provider: { metadata: { name }, type: profile.id, profileWorkspace: profile.scope === 'workspace' ? workspace : '', credentials, config: {} },
  })
  return { name }
}

async function rotateSecret(name, input) {
  const { client, workspaceScope } = await gateway()
  const current = await client.raw.getProvider({ name, workspaceScope: workspaceScope })
  const credentials = credentialMap(input.credentials)
  if (!Object.keys(credentials).length) throw fail('Enter a new value.')
  const known = Object.keys(current.provider.credentials ?? {})
  for (const key of Object.keys(credentials)) if (!known.includes(key)) throw fail(`${key} is not a credential of this secret.`)
  const response = await client.raw.updateProvider({
    workspaceScope: workspaceScope, requestId: randomUUID(),
    provider: { metadata: { name }, type: current.provider.type, credentials, config: {} },
  })
  return { ok: true, sandboxesNotified: response.targetReceipts?.length ?? 0 }
}

async function setExpiry(name, input) {
  const { client, workspaceScope } = await gateway()
  const current = await client.raw.getProvider({ name, workspaceScope: workspaceScope })
  const key = String(input.key ?? '')
  if (!(key in (current.provider.credentials ?? {}))) throw fail('Unknown credential.')
  const base = { workspaceScope: workspaceScope, requestId: randomUUID(), provider: { metadata: { name }, type: current.provider.type, credentials: {}, config: {} } }
  if (!input.expiresAt) {
    await client.raw.updateProvider({ ...base, clearCredentialExpirationKeys: [key] })
  } else {
    const t = Date.parse(input.expiresAt)
    if (!Number.isFinite(t) || t < Date.now()) throw fail('Pick a date in the future.')
    await client.raw.updateProvider({ ...base, credentialExpirationTimes: { [key]: { seconds: BigInt(Math.floor(t / 1000)), nanos: 0 } } })
  }
  return { ok: true }
}

async function deleteSecret(name) {
  const { client, workspaceScope } = await gateway()
  await client.raw.deleteProvider({ name, workspaceScope: workspaceScope })
  return { ok: true }
}

async function attachment(sandbox, provider, attach) {
  const { client, workspaceScope } = await gateway()
  const request = { sandbox, provider, workspaceScope: workspaceScope, requestId: randomUUID() }
  const response = attach ? await client.raw.attachSandboxProvider(request) : await client.raw.detachSandboxProvider(request)
  return { changed: attach ? response.attached : response.detached }
}

async function importProfile(id) {
  if (!PROFILE_CATALOG.some((p) => p.id === id)) throw fail('Unknown profile.')
  const { target, workspace } = await gateway()
  const url = `https://raw.githubusercontent.com/NVIDIA/OpenShell/v0.1.2/providers/${id}.yaml`
  try {
    const { stdout } = await exec('openshell', ['--gateway', target.name, '--workspace', workspace, 'profile', 'import', '--url', url], { timeout: 30000, maxBuffer: 1 << 20 })
    return { ok: true, message: stdout.trim() }
  } catch (error) {
    throw fail((error.stderr || error.message).toString().split('\n').filter(Boolean).slice(-3).join(' '), 502)
  }
}

// ---- create-time policy templates ------------------------------------------
//
// Files, Landlock and process identity are fixed when a sandbox is created, so
// they live in templates the New sandbox dialog applies. Stored as JSON next
// to the console so they can be reviewed and committed like code.

const TEMPLATE_ID = /^[a-z0-9][a-z0-9-]{0,47}$/
const ABS = /^\/[\w.@+-][\w./@+-]{0,255}$/
const SYSTEM_RO = ['/bin', '/usr', '/lib', '/proc', '/dev/urandom', '/etc', '/var/log']

// Hidden compatibility presets for existing saved references and imported images.
const LEGACY_TEMPLATES = [
  {
    id: 'claude-subscription', builtin: true, name: 'Claude Code subscription',
    description: 'Sign in with your Claude subscription. Allows Claude Code to reach Anthropic API and sign-in endpoints without an API-key provider. Run claude and choose your subscription account after connecting.',
    filesystem: { workdir: true, readOnly: SYSTEM_RO, readWrite: ['/tmp', '/dev/null'] }, landlock: 'best_effort',
    rules: [
      { name: 'claude-subscription', binaries: ['/usr/bin/claude', '/usr/local/bin/claude'],
        endpoints: ['api.anthropic.com', 'platform.claude.com', 'claude.ai'].map((host) => (
          { host, ports: [443], protocol: 'rest', access: 'read-write', enforcement: 'enforce' }
        )) },
    ],
  },
  {
    id: 'claude-github-readonly', builtin: true, name: 'Claude Code + GitHub read-only',
    description: 'Claude can clone and read public GitHub repos but cannot push, open issues or reach any other code host.',
    filesystem: { workdir: true, readOnly: SYSTEM_RO, readWrite: ['/tmp', '/dev/null'] }, landlock: 'best_effort',
    rules: [
      { name: 'github-read', binaries: ['/usr/lib/git-core/git-remote-http', '/usr/lib/git-core/git-remote-https', '/usr/local/bin/claude'],
        endpoints: [
          // git clone and fetch POST to git-upload-pack, so GET-only would block them.
          // Pushing POSTs to git-receive-pack, which stays denied.
          { host: 'github.com', ports: [443], protocol: 'rest', enforcement: 'enforce',
            allow: [
              { method: 'GET', path: '/**' }, { method: 'HEAD', path: '/**' }, { method: 'OPTIONS', path: '/**' },
              { method: 'POST', path: '/*/*/git-upload-pack' },
            ],
            deny: [{ method: '*', path: '/*/*/git-receive-pack' }] },
          { host: 'api.github.com', ports: [443], protocol: 'rest', access: 'read-only', enforcement: 'enforce' },
          { host: 'codeload.github.com', ports: [443], protocol: 'rest', access: 'read-only', enforcement: 'enforce' },
        ] },
    ],
  },
]

export function validateTemplate(input) {
  const id = String(input.id ?? '').trim()
  if (!TEMPLATE_ID.test(id)) throw fail('Template ids use lowercase letters, digits and dashes.')
  const builtin = [...BUILTIN_TEMPLATES, ...LEGACY_TEMPLATES].find((t) => t.id === id)
  const kind = builtin?.kind ?? (['access', 'baseline'].includes(input.kind) ? input.kind : undefined)
  const list = (v) => (Array.isArray(v) ? v.map(String).map((s) => s.trim()).filter(Boolean) : [])
  const readOnly = list(input.filesystem?.readOnly)
  const readWrite = list(input.filesystem?.readWrite)
  if (readWrite.includes('/')) throw fail('The root folder cannot be writable.')
  for (const p of [...readOnly, ...readWrite]) if (p !== '/' && (!ABS.test(p) || p.includes('..'))) throw fail(`"${p}" must be an absolute path without "..".`)
  if (readOnly.length + readWrite.length > 256) throw fail('Too many paths.')
  const landlock = input.landlock === 'hard_requirement' ? 'hard_requirement' : 'best_effort'
  let accessTemplates
  // Validate persisted reference shapes here. The store and launch composition
  // resolve their existence and access type against the destination catalog,
  // which also contains imported presets with remapped ids.
  const references = input.accessTemplates ?? []
  if (!Array.isArray(references) || references.some(reference => typeof reference !== 'string' || !TEMPLATE_ID.test(reference))) throw fail('Choose valid additional access templates.')
  try { accessTemplates = normalizeAccessTemplates(references, references.map(reference => ({ id: reference, kind: 'access' }))) } catch (error) { throw fail(error.message) }
  const rules = (input.rules ?? []).map((r) => { ruleToProto(r); return r })
  if (kind === 'access' && accessTemplates.length) throw fail('An access policy cannot include other access policies.')
  if (new Set(rules.map((r) => r.name)).size !== rules.length) throw fail('Rule names must be unique.')
  // Services to open when the sandbox starts, each with an optional auto-close.
  const ingress = (input.ingress ?? []).map((d) => {
    const name = String(d.name ?? '')
    const port = Number(d.port)
    const minutes = d.closeAfterMinutes === null || d.closeAfterMinutes === undefined ? null : Number(d.closeAfterMinutes)
    if (!/^([a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?)?$/.test(name)) throw fail('Service names use lowercase letters, digits and dashes.')
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw fail('Service ports are 1–65535.')
    if (minutes !== null && (!Number.isInteger(minutes) || minutes < 5 || minutes > 10080)) throw fail('Auto-close must be 5 minutes to 7 days.')
    return { name, port, closeAfterMinutes: minutes }
  })
  if (new Set(ingress.map((d) => d.name)).size !== ingress.length) throw fail('Each opened service needs its own name.')
  return {
    id,
    builtin: Boolean(builtin),
    ...(kind ? { kind } : {}),
    name: String(input.name ?? id).slice(0, 80),
    description: String(input.description ?? '').slice(0, 400),
    filesystem: { workdir: input.filesystem?.workdir !== false, readOnly, readWrite },
    landlock,
    accessTemplates,
    rules,
    ingress,
  }
}

export function templateToPolicy(template) {
  return {
    version: 1,
    filesystem: { includeWorkdir: template.filesystem.workdir, readOnly: template.filesystem.readOnly, readWrite: template.filesystem.readWrite },
    landlock: { compatibility: template.landlock },
    networkPolicies: Object.fromEntries(template.rules.map((r) => { const { name, rule } = ruleToProto(r); return [name, rule] })),
  }
}

const templateStores = new Map()
async function templateStore() {
  const directory = await policyDirectory()
  if (!templateStores.has(directory)) {
    templateStores.set(directory, createTemplateStore({ directory, builtins: BUILTIN_TEMPLATES, legacy: LEGACY_TEMPLATES, validate: validateTemplate }))
  }
  return templateStores.get(directory)
}
export const listTemplates = async () => (await templateStore()).list()
export const findTemplate = async (id) => (await templateStore()).find(id)
const saveTemplate = async (input) => (await templateStore()).save(input)
const deleteTemplate = async (id) => (await templateStore()).deleteMany([id])

// ---- routes -----------------------------------------------------------------

const SANDBOX = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

export async function policyRoute(method, parts, input) {
  const [area, a, b, c] = parts
  if (method === 'GET') {
    if (area === 'policy' && a === 'fleet') return fleet()
    if (area === 'policy' && a === 'global') return globalPolicy()
    if (area === 'policy' && SANDBOX.test(a ?? '') && !b) return policyOf(a)
    if (area === 'policy' && SANDBOX.test(a ?? '') && b === 'revisions' && /^\d+$/.test(c ?? '')) {
      const { revision, policy } = await revisionPolicy(a, Number(c))
      return { revision, policy: policyView(policy) }
    }
    if (area === 'settings') return settings(a && SANDBOX.test(a) ? a : null)
    if (area === 'secrets') return secrets()
    if (area === 'templates') return listTemplates()
    return undefined
  }
  if (area === 'policy' && a === 'global' && b === 'remove') return removeGlobal()
  if (area === 'policy' && SANDBOX.test(a ?? '') && b === 'ops') return applyOps(a, input.ops)
  if (area === 'policy' && SANDBOX.test(a ?? '') && b === 'restore') return restore(a, Number(input.version))
  if (area === 'settings') return setSetting({ ...input, sandbox: input.sandbox && SANDBOX.test(input.sandbox) ? input.sandbox : null })
  if (area === 'secrets' && !a) return createSecret(input)
  if (area === 'secrets' && SECRET_NAME.test(a ?? '')) {
    if (b === 'rotate') return rotateSecret(a, input)
    if (b === 'expiry') return setExpiry(a, input)
    if (b === 'delete') return deleteSecret(a)
    if ((b === 'attach' || b === 'detach') && SANDBOX.test(input.sandbox ?? '')) return attachment(input.sandbox, a, b === 'attach')
  }
  if (area === 'profiles' && a === 'import') return importProfile(String(input.id ?? ''))
  if (area === 'templates' && !a) return saveTemplate(input)
  if (area === 'templates' && a === 'delete' && !b) return (await templateStore()).deleteMany(input.ids)
  if (area === 'templates' && a && b === 'delete') return deleteTemplate(a)
  return undefined
}
