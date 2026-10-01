import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { ruleToProto } from './policy.js'
import { appliesTo, blockHosts } from '../src/lib/egress.js'

export { appliesTo, blockHosts }

const fail = (message, status = 400) => Object.assign(new Error(message), { status })

// ---- egress policies ---------------------------------------------------------
//
// A policy is a name, some destinations, and an action: allow or block. It
// applies to everyone, to groups, to named sandboxes, or to the sandboxes that
// use an MCPs & Skills setup (server/setup-egress.js). Sandboxes start
// locked down, so nothing leaves one until an allow policy covers it, and a
// block (a block policy or the organization's blocked hosts) beats every allow.
//
// OpenShell has no host-level deny, so a block is an inspected endpoint whose
// deny rules match every request. It answers HTTP with policy_denied and
// refuses anything that is not HTTP. It has to cover every port the sandbox's
// other rules open, or a blocked host would stay open on the others.
//
// Stored as JSON in policies/egress/<id>.json, reviewed like code.

const DIR = path.resolve(import.meta.dirname, '../policies/egress')
const ID = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/
const HOST = /^(\*\*?\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i
const SANDBOX = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
const SETUP = /^[a-f0-9]{24}$/
const BINARY = /^\/[\w.+@*?/[\]-]{1,255}$/
const CIDR = /^[0-9a-f:.]+(\/\d{1,3})?$/i
const REQUESTS = ['any', 'read-only', 'read-write', 'custom']
const METHODS = ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE', '*']

export const PREFIX = 'egress_'
export const BLOCK_ALL = [{ method: '*', path: '/' }, { method: '*', path: '/**' }]
export const DEFAULT_ADVANCED = { ports: [443, 80], programs: [], requests: 'any', allow: [], deny: [], enforcement: 'enforce', privateIps: [] }
const WEB_PORTS = [443, 80]

const list = (v) => (Array.isArray(v) ? v : [])
const uniq = (items) => [...new Set(items)]

function requestList(input, where) {
  return list(input).map((r) => {
    const method = String(r?.method ?? '').toUpperCase()
    const p = String(r?.path ?? '').trim()
    if (!METHODS.includes(method)) throw fail(`${where}: unsupported method "${r?.method}".`)
    if (!p.startsWith('/') || p.length > 512) throw fail(`${where}: a path must start with "/".`)
    return { method, path: p }
  })
}

function validateAdvanced(input) {
  const a = { ...DEFAULT_ADVANCED, ...(input ?? {}) }
  const ports = uniq(list(a.ports).map(Number))
  if (!ports.length || ports.some((p) => !Number.isInteger(p) || p < 1 || p > 65535)) throw fail('Ports must be 1–65535.')
  const programs = uniq(list(a.programs).map((p) => String(p).trim()).filter(Boolean))
  for (const p of programs) if (!BINARY.test(p)) throw fail(`"${p}" is not an absolute program path.`)
  if (!REQUESTS.includes(a.requests)) throw fail('Unknown request setting.')
  const allow = a.requests === 'custom' ? requestList(a.allow, 'Allowed request') : []
  if (a.requests === 'custom' && !allow.length) throw fail('Add at least one allowed request, or allow any request.')
  const deny = requestList(a.deny, 'Blocked request')
  const privateIps = uniq(list(a.privateIps).map((ip) => String(ip).trim()).filter(Boolean))
  for (const ip of privateIps) if (!CIDR.test(ip)) throw fail(`"${ip}" is not an IP or CIDR.`)
  return { ports, programs, requests: a.requests, allow, deny, enforcement: a.enforcement === 'audit' ? 'audit' : 'enforce', privateIps }
}

export function validatePolicy(input) {
  const name = String(input?.name ?? '').trim().slice(0, 80)
  if (!name) throw fail('Give the rule a name.')
  const id = String(input?.id ?? '').trim()
  if (!ID.test(id)) throw fail('Rule ids use lowercase letters, digits and dashes (up to 40).')
  const action = input?.action === 'block' ? 'block' : input?.action === 'allow' ? 'allow' : null
  if (!action) throw fail('Choose allow or block.')
  const destinations = hostList(input.destinations)
  if (!destinations.length) throw fail('Add at least one destination.')
  const to = input.appliesTo ?? {}
  const appliesTo = {
    everyone: Boolean(to.everyone),
    groups: uniq(list(to.groups).map(String)),
    sandboxes: uniq(list(to.sandboxes).map(String)),
    setups: uniq(list(to.setups).map(String)),
  }
  for (const s of appliesTo.sandboxes) if (!SANDBOX.test(s)) throw fail(`"${s}" is not a sandbox name.`)
  for (const s of appliesTo.setups) if (!SETUP.test(s)) throw fail(`"${s}" is not an MCPs & Skills setup.`)
  const policy = { id, name, action, destinations, appliesTo }
  if (action === 'allow') policy.advanced = validateAdvanced(input.advanced)
  if (input.setup != null) policy.setup = setupMarker(input.setup)
  return policy
}

function hostList(input) {
  const hosts = uniq(list(input).map((h) => String(h).trim().toLowerCase().replace(/\.$/, '')).filter(Boolean))
  if (hosts.length > 200) throw fail('Too many destinations. Split them into several rules.')
  for (const h of hosts) {
    if (h === '*' || h === '**') throw fail('"All destinations" needs OpenShell support that does not exist yet. List the hosts instead.')
    if (!HOST.test(h)) throw fail(`"${h}" is not a host (wildcards: *.example.com or **.example.com).`)
    if (/^\*\*?\./.test(h) && h.split('.').length < 3) throw fail(`"${h}" is too broad. OpenShell needs at least two labels after the wildcard.`)
  }
  return hosts
}

// The console keeps one allow policy per MCPs & Skills setup. The marker names
// the setup and the hosts and ports it needs, so a recompute keeps the ones
// people added.
function setupMarker(input) {
  const id = String(input?.id ?? '')
  if (!SETUP.test(id)) throw fail('Unknown MCPs & Skills setup.')
  const name = String(input.name ?? '').trim().slice(0, 80)
  if (/[\x00-\x1f\x7f]/.test(name)) throw fail('The setup name has control characters.')
  const ports = uniq(list(input.ports).map(Number))
  if (ports.some((p) => !Number.isInteger(p) || p < 1 || p > 65535)) throw fail('Ports must be 1–65535.')
  return { id, name, required: hostList(input.required), ports }
}

// ---- storage -----------------------------------------------------------------

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

// `dir` is for tests.
export async function listPolicies(dir = DIR) {
  let files = []
  try { files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json')) } catch (error) { if (error.code !== 'ENOENT') throw error }
  const policies = await Promise.all(files.map(async (f) => { try { return validatePolicy(await readJson(path.join(dir, f))) } catch { return null } }))
  return policies.filter(Boolean).sort((a, b) => a.name.localeCompare(b.name))
}

export async function writePolicy(policy, dir = DIR) {
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, `${policy.id}.json`), temporary = `${file}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, `${JSON.stringify(policy, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    await fs.rename(temporary, file)
  } finally { await fs.rm(temporary, { force: true }) }
}

export async function removePolicy(id, dir = DIR) {
  if (!ID.test(String(id))) throw fail('Unknown rule.')
  await fs.rm(path.join(dir, `${id}.json`), { force: true })
}

// ---- compile -----------------------------------------------------------------

function allowSpec(policy) {
  const a = policy.advanced
  // "Any request" with nothing blocked needs no inspection at all.
  const inspect = a.requests !== 'any' || a.deny.length > 0
  return {
    name: PREFIX + policy.id,
    binaries: a.programs.length ? a.programs : ['/**'],
    endpoints: policy.destinations.map((host) => ({
      host,
      ports: a.ports,
      protocol: inspect ? 'rest' : 'tcp',
      access: !inspect ? null : a.requests === 'any' ? 'full' : a.requests === 'custom' ? null : a.requests,
      allow: a.requests === 'custom' ? a.allow : [],
      deny: inspect ? a.deny : [],
      enforcement: a.enforcement,
      allowedIps: a.privateIps,
    })),
  }
}

function blockSpec(name, hosts, ports) {
  return {
    name,
    binaries: ['/**'],
    endpoints: uniq(hosts.flatMap(blockHosts)).map((host) => ({ host, ports, protocol: 'rest', access: 'full', deny: BLOCK_ALL, enforcement: 'enforce' })),
  }
}

// The console-owned rules for one sandbox, keyed by policy name: every allow
// and block policy that applies to it, plus the organization's blocked hosts.
// `openPorts` are the ports the sandbox's other rules (template, one-off,
// provider) open, so a block covers those as well as the allows' ports.
export function compileFor(sandbox, policies, orgBlocked = [], openPorts = []) {
  const mine = policies.filter((p) => appliesTo(p, sandbox))
  const allows = mine.filter((p) => p.action === 'allow')
  const ports = uniq([...WEB_PORTS, ...allows.flatMap((p) => p.advanced.ports), ...openPorts.map(Number)]).sort((a, b) => a - b)
  const specs = [
    ...allows.map(allowSpec),
    ...mine.filter((p) => p.action === 'block').map((p) => blockSpec(PREFIX + p.id, p.destinations, ports)),
    ...(orgBlocked.length ? [blockSpec('org_blocked', orgBlocked, ports)] : []),
  ]
  const out = {}
  for (const spec of specs) { const { rule } = ruleToProto(spec); out[spec.name] = { ...rule, name: spec.name } }
  return out
}

// A request is settled by a block policy when one of its hosts is covered.
export function blockedByPolicy(policies, sandbox, hosts, matches) {
  for (const p of policies) {
    if (p.action !== 'block' || !appliesTo(p, sandbox)) continue
    for (const host of hosts) if (p.destinations.flatMap(blockHosts).some((d) => matches(d, host))) return { host, policy: p }
  }
  return null
}
