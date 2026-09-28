import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { WORKSPACE, gateway, sandboxView } from './gateway.js'
import { findTemplate, ruleToProto, templateToPolicy } from './policy.js'

const fail = (message, status = 400) => Object.assign(new Error(message), { status })

// ---- organization → group → sandbox ------------------------------------------
//
// The gateway holds one policy per sandbox, and its global policy replaces a
// sandbox's policy rather than adding to it. So the layering lives here: the
// console writes the organization's rules and the sandbox's group's rules into
// every sandbox's own policy, under reserved name prefixes, and leaves the
// sandbox's other rules alone. Group membership is a label, which the gateway
// fixes at creation, so a sandbox's group is decided before it ever runs.
//
// Stored as JSON next to the templates, so policy is reviewed and committed
// like code: policies/org/organization.json and policies/org/groups/<id>.json.

const ORG_DIR = path.resolve(import.meta.dirname, '../policies/org')
const GROUP_DIR = path.join(ORG_DIR, 'groups')
export const GROUP_LABEL = 'openshell.console/group'
const GROUP_ID = /^[a-z0-9]([a-z0-9-]{0,46}[a-z0-9])?$/
const HOST_PATTERN = /^(\*\*?\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i

// What happens to a request no rule covers.
//   ask:   it waits in Approvals for a person.
//   auto:  the gateway applies drafts its prover finds clean; the rest wait.
//   block: the console rejects it on sight; nobody is asked.
const OUTSIDE = ['ask', 'auto', 'block']

export const PREFIX = { org: 'org_', group: 'group_' }
export const isManaged = (key) => key.startsWith(PREFIX.org) || key.startsWith(PREFIX.group)

const EMPTY_ORG = { rules: [], blocked: [], outside: 'ask' }

function validateRules(input, prefix) {
  const rules = (Array.isArray(input) ? input : []).map((r) => {
    const name = String(r?.name ?? '')
    if (name.length + prefix.length > 64) throw fail(`Rule "${name}" needs a shorter name.`)
    ruleToProto(r)
    return r
  })
  if (new Set(rules.map((r) => r.name)).size !== rules.length) throw fail('Rule names must be unique.')
  return rules
}

function validateBlocked(input) {
  const hosts = [...new Set((Array.isArray(input) ? input : []).map((h) => String(h).trim().toLowerCase()).filter(Boolean))]
  for (const h of hosts) if (!HOST_PATTERN.test(h)) throw fail(`"${h}" is not a host (wildcards: *.example.com or **.example.com).`)
  if (hosts.length > 500) throw fail('Too many blocked hosts.')
  return hosts
}

// `*.a.com` is one label deep, `**.a.com` any depth; otherwise exact.
export function hostMatches(pattern, host) {
  host = String(host ?? '').toLowerCase()
  if (pattern.startsWith('**.')) return host.endsWith(pattern.slice(2))
  if (pattern.startsWith('*.')) {
    const rest = pattern.slice(1)
    return host.endsWith(rest) && !host.slice(0, -rest.length).includes('.') && host.length > rest.length
  }
  return host === pattern
}

// A rule host collides with a blocked pattern when either one covers the other:
// `**.example.com` in a rule would open a blocked `api.example.com`.
function overlapsBlocked(blocked, ruleHost) {
  const bare = (p) => p.replace(/^\*\*?\./, '')
  return blocked.find((b) => hostMatches(b, ruleHost) || hostMatches(ruleHost, bare(b)) || (ruleHost.startsWith('*') && bare(ruleHost) === bare(b))) ?? null
}

export function blockedBy(org, hosts) {
  for (const host of hosts) {
    const hit = org.blocked.find((b) => hostMatches(b, host))
    if (hit) return { host, pattern: hit }
  }
  return null
}

function assertNotBlocked(org, rules, where) {
  for (const r of rules) for (const e of r.endpoints ?? []) {
    const hit = overlapsBlocked(org.blocked, String(e.host ?? '').toLowerCase())
    if (hit) throw fail(`${where}: rule "${r.name}" reaches ${e.host}, which the organization blocks (${hit}).`)
  }
}

// ---- storage ----------------------------------------------------------------

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

export async function readOrg() {
  const raw = await readJson(path.join(ORG_DIR, 'organization.json'))
  if (!raw) return { ...EMPTY_ORG }
  return {
    rules: validateRules(raw.rules, PREFIX.org),
    blocked: validateBlocked(raw.blocked),
    outside: OUTSIDE.includes(raw.outside) ? raw.outside : 'ask',
  }
}

function validateGroup(input) {
  const id = String(input.id ?? '').trim()
  if (!GROUP_ID.test(id)) throw fail('Group ids use lowercase letters, digits and dashes.')
  const outside = input.outside === 'inherit' || OUTSIDE.includes(input.outside) ? input.outside : 'inherit'
  return {
    id,
    name: String(input.name ?? id).trim().slice(0, 80) || id,
    description: String(input.description ?? '').slice(0, 400),
    template: input.template ? String(input.template) : 'locked-down',
    rules: validateRules(input.rules, PREFIX.group),
    outside,
  }
}

export async function listGroups() {
  let files = []
  try { files = (await fs.readdir(GROUP_DIR)).filter((f) => f.endsWith('.json')) } catch (error) { if (error.code !== 'ENOENT') throw error }
  const groups = await Promise.all(files.map(async (f) => { try { return validateGroup(await readJson(path.join(GROUP_DIR, f))) } catch { return null } }))
  return groups.filter(Boolean).sort((a, b) => a.name.localeCompare(b.name))
}

export async function findGroup(id) {
  if (!GROUP_ID.test(String(id ?? ''))) return null
  const raw = await readJson(path.join(GROUP_DIR, `${id}.json`))
  return raw ? validateGroup(raw) : null
}

const write = async (file, value) => {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

// ---- composition -------------------------------------------------------------

export const effectiveOutside = (org, group) => (group && group.outside !== 'inherit' ? group.outside : org.outside)

// The rules the console owns in a sandbox's policy, keyed by their policy name.
function managedRules(org, group) {
  const out = {}
  for (const r of org.rules) { const { rule } = ruleToProto(r); out[PREFIX.org + r.name] = { ...rule, name: PREFIX.org + r.name } }
  for (const r of group?.rules ?? []) { const { rule } = ruleToProto(r); out[PREFIX.group + r.name] = { ...rule, name: PREFIX.group + r.name } }
  return out
}

// Everything a new sandbox needs from its group, resolved before it exists.
export async function planSandbox({ group: groupId, template: templateId }) {
  const org = await readOrg()
  let group = null
  if (groupId) {
    group = await findGroup(groupId)
    if (!group) throw fail('Unknown group.')
  }
  const template = await findTemplate(group ? group.template : templateId || 'locked-down')
  if (!template) throw fail('Unknown policy template.')
  assertNotBlocked(org, template.rules, 'Template')
  const policy = templateToPolicy(template)
  Object.assign(policy.networkPolicies, managedRules(org, group))
  return {
    policy,
    template,
    labels: group ? { [GROUP_LABEL]: group.id } : {},
    approvalMode: effectiveOutside(org, group) === 'auto' ? 'auto' : 'manual',
  }
}

async function setApprovalMode(client, sandbox, mode) {
  await client.raw.updateConfig({
    sandbox, workspaceScope: WORKSPACE, global: false,
    settingKey: 'proposal_approval_mode', settingValue: { value: { case: 'stringValue', value: mode } },
    requestId: randomUUID(),
  })
}
export { setApprovalMode }

// Rewrites the managed rules of one sandbox to match the stored policy. The
// sandbox's own rules are never touched.
async function syncOne(client, sandbox, org, groups, { force = true } = {}) {
  const groupId = sandbox.labels?.[GROUP_LABEL] ?? null
  const group = groupId ? groups.find((g) => g.id === groupId) ?? null : null
  const desired = managedRules(org, group)
  const status = await client.raw.getSandboxPolicyStatus({ sandbox: sandbox.name, workspaceScope: WORKSPACE })
  const current = Object.keys(status.revision?.policy?.networkPolicies ?? {}).filter(isManaged)
  const same = current.length === Object.keys(desired).length && current.every((k) => k in desired)
  const mode = effectiveOutside(org, group) === 'auto' ? 'auto' : 'manual'
  if (!force && same) return { changed: false }
  const ops = [
    ...current.map((ruleName) => ({ operation: { case: 'removeRule', value: { ruleName } } })),
    ...Object.entries(desired).map(([ruleName, rule]) => ({ operation: { case: 'addRule', value: { ruleName, rule } } })),
  ]
  let version = null
  if (ops.length) {
    const response = await client.raw.updateConfig({
      sandbox: sandbox.name, workspaceScope: WORKSPACE, global: false, mergeOperations: ops,
      annotations: { 'console.openshell/change': `org-sync:${group ? `group=${group.id}` : 'org'}` },
      requestId: randomUUID(),
    })
    version = response.version
  }
  await setApprovalMode(client, sandbox.name, mode)
  return { changed: true, version }
}

async function liveSandboxes(client) {
  const response = await client.raw.listSandboxes({ workspaceScope: WORKSPACE })
  return response.sandboxes.map(sandboxView).filter((s) => s.phase !== 'deleting')
}

export async function syncAll({ group: onlyGroup = null, force = true } = {}) {
  const { client } = await gateway()
  const [org, groups, sandboxes] = await Promise.all([readOrg(), listGroups(), liveSandboxes(client)])
  const targets = onlyGroup ? sandboxes.filter((s) => s.labels?.[GROUP_LABEL] === onlyGroup) : sandboxes
  const results = await Promise.all(targets.map(async (s) => {
    try { return { sandbox: s.name, ...(await syncOne(client, s, org, groups, { force })) } } catch (error) { return { sandbox: s.name, error: error.rawMessage ?? error.message } }
  }))
  return {
    applied: results.filter((r) => r.changed).map((r) => r.sandbox),
    failed: results.filter((r) => r.error).map(({ sandbox, error }) => ({ sandbox, error })),
  }
}

// Whether policy settles this request without a person, and why.
export function settledBy(org, group, hosts) {
  const hit = blockedBy(org, hosts)
  if (hit) return `Blocked by organization policy (${hit.pattern}).`
  if (effectiveOutside(org, group) === 'block') return `Outside the ${group ? `${group.name} group` : 'organization'} policy. Add a rule there to allow it.`
  return null
}

export async function policyContext() {
  const [org, groups] = await Promise.all([readOrg(), listGroups()])
  return { org, groupOf: (sandbox) => groups.find((g) => g.id === sandbox.labels?.[GROUP_LABEL]) ?? null }
}

// ---- the background pass ------------------------------------------------------
//
// Settles what policy already decided, so people only see what it didn't:
// requests for blocked hosts and requests from "keep blocked" groups are
// rejected, approvals of blocked hosts (e.g. by the gateway's auto mode) are
// taken back, and sandboxes created outside the console get their rules.

async function sweep(log) {
  const { client } = await gateway()
  const [org, groups, sandboxes] = await Promise.all([readOrg(), listGroups(), liveSandboxes(client)])
  for (const s of sandboxes) {
    const group = groups.find((g) => g.id === s.labels?.[GROUP_LABEL]) ?? null
    try {
      const result = await syncOne(client, s, org, groups, { force: false })
      if (result.changed) log(`applied organization policy to ${s.name}`)
    } catch { /* retried next pass */ }
    let draft
    try { draft = await client.raw.getDraftPolicy({ sandbox: s.name, workspaceScope: WORKSPACE }) } catch { continue }
    for (const chunk of draft.chunks) {
      const hosts = (chunk.proposedRule?.endpoints ?? []).map((e) => e.host)
      const hit = blockedBy(org, hosts)
      const reason = settledBy(org, group, hosts)
      const common = { sandbox: s.name, chunkId: chunk.id, workspaceScope: WORKSPACE, requestId: randomUUID() }
      try {
        if (chunk.status === 'pending' && reason) {
          await client.raw.rejectDraftChunk({ ...common, reason })
          log(`rejected ${hosts[0] ?? chunk.ruleName} for ${s.name}: ${reason}`)
        } else if (chunk.status === 'approved' && hit) {
          await client.raw.undoDraftChunk(common)
          log(`revoked ${hit.host} for ${s.name}: blocked by organization`)
        }
      } catch { /* the chunk changed under us; next pass */ }
    }
  }
}

export function startOrgSweeper(log) {
  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try { await sweep(log) } catch { /* gateway unreachable; next pass */ } finally { running = false }
  }
  tick()
  const timer = setInterval(tick, 15000)
  timer.unref?.()
  return () => clearInterval(timer)
}

// ---- routes -----------------------------------------------------------------

async function overview() {
  const { client } = await gateway()
  const [org, groups, sandboxes] = await Promise.all([readOrg(), listGroups(), liveSandboxes(client)])
  const members = Object.fromEntries(groups.map((g) => [g.id, []]))
  const ungrouped = []
  const orphaned = []
  for (const s of sandboxes) {
    const id = s.labels?.[GROUP_LABEL]
    if (!id) ungrouped.push(s.name)
    else if (members[id]) members[id].push(s.name)
    else orphaned.push({ sandbox: s.name, group: id })
  }
  return { org, groups, members, ungrouped, orphaned, total: sandboxes.length }
}

async function saveOrg(input) {
  const org = {
    rules: validateRules(input.rules, PREFIX.org),
    blocked: validateBlocked(input.blocked),
    outside: OUTSIDE.includes(input.outside) ? input.outside : 'ask',
  }
  assertNotBlocked(org, org.rules, 'Organization')
  for (const g of await listGroups()) assertNotBlocked(org, g.rules, `Group ${g.name}`)
  await write(path.join(ORG_DIR, 'organization.json'), org)
  return { org, ...(await syncAll()) }
}

async function saveGroup(input) {
  const group = validateGroup(input)
  if (!(await findTemplate(group.template))) throw fail('Unknown policy template.')
  assertNotBlocked(await readOrg(), group.rules, `Group ${group.name}`)
  await write(path.join(GROUP_DIR, `${group.id}.json`), group)
  return { group, ...(await syncAll({ group: group.id })) }
}

async function deleteGroup(id) {
  if (!GROUP_ID.test(id)) throw fail('Unknown group.')
  const { members } = await overview()
  if (members[id]?.length) throw fail(`${members[id].length} sandbox${members[id].length === 1 ? ' is' : 'es are'} still in this group. A sandbox keeps its group for life; delete those sandboxes first.`)
  await fs.rm(path.join(GROUP_DIR, `${id}.json`), { force: true })
  return { ok: true }
}

export async function orgRoute(method, parts, input) {
  const [area, a, b, c] = parts
  if (area !== 'org') return undefined
  if (method === 'GET' && !a) return overview()
  if (method !== 'POST') return undefined
  if (!a) return saveOrg(input)
  if (a === 'sync') return syncAll()
  if (a === 'groups' && !b) return saveGroup(input)
  if (a === 'groups' && b && c === 'delete') return deleteGroup(b)
  return undefined
}
