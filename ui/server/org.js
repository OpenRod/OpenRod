import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { WORKSPACE, gateway, sandboxView } from './gateway.js'
import { findTemplate, ruleToProto, templateToPolicy } from './policy.js'
import { appliesTo, blockHosts, blockedByPolicy, compileFor, listPolicies, removePolicy, validatePolicy, writePolicy } from './egress.js'
import { hostMatches } from '../src/lib/egress.js'

export { hostMatches }

const fail = (message, status = 400) => Object.assign(new Error(message), { status })

// ---- organization → group → sandbox ------------------------------------------
//
// The gateway holds one policy per sandbox, and its global policy replaces a
// sandbox's policy rather than adding to it. So the layering lives here: the
// console writes the egress policies that apply to a sandbox (everyone, its
// group, or the sandbox by name) and the organization's blocked hosts into
// every sandbox's own policy, under reserved name prefixes, and leaves the
// sandbox's other rules alone.
//
// Group membership is stored here rather than in the sandbox: the gateway
// fixes labels at creation, and people move sandboxes between groups. A
// sandbox with no stored membership falls back to the group label it was
// created with, so sandboxes from before membership was stored keep theirs.
//
// Stored as JSON next to the templates, so policy is reviewed and committed
// like code: policies/org/organization.json, policies/org/groups/<id>.json,
// policies/org/members.json and policies/egress/<id>.json.

const ORG_DIR = path.resolve(import.meta.dirname, '../policies/org')
const GROUP_DIR = path.join(ORG_DIR, 'groups')
const MEMBERS_FILE = path.join(ORG_DIR, 'members.json')
const SANDBOX_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
export const GROUP_LABEL = 'openshell.console/group'
const GROUP_ID = /^[a-z0-9]([a-z0-9-]{0,46}[a-z0-9])?$/
const HOST_PATTERN = /^(\*\*?\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i

// Connections outside configured policy always stay blocked. `group_` rules
// predate egress policies; the next sync removes them.
export const PREFIX = { org: 'org_', group: 'group_', egress: 'egress_' }
export const isManaged = (key) => Object.values(PREFIX).some((prefix) => key.startsWith(prefix))

const EMPTY_ORG = { blocked: [], outside: 'block' }

function validateBlocked(input) {
  const hosts = [...new Set((Array.isArray(input) ? input : []).map((h) => String(h).trim().toLowerCase()).filter(Boolean))]
  for (const h of hosts) if (!HOST_PATTERN.test(h)) throw fail(`"${h}" is not a host (wildcards: *.example.com or **.example.com).`)
  if (hosts.length > 500) throw fail('Too many blocked hosts.')
  return hosts
}

// A rule host collides with a blocked pattern when either one covers the other:
// `**.example.com` in a rule would open a blocked `api.example.com`.
function overlapsBlocked(blocked, ruleHost) {
  const bare = (p) => p.replace(/^\*\*?\./, '')
  return blocked.find((b) => hostMatches(b, ruleHost) || hostMatches(ruleHost, bare(b)) || (ruleHost.startsWith('*') && bare(ruleHost) === bare(b))) ?? null
}

export function blockedBy(org, hosts) {
  for (const host of hosts) {
    const hit = org.blocked.find((b) => blockHosts(b).some((pattern) => hostMatches(pattern, host)))
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

// OpenShell rejects a block and an allow on the same host when they disagree
// on audit mode or private addresses. Say so here rather than per sandbox.
function assertCompatible(org, policies) {
  const blocks = [
    ...org.blocked.map((host) => ({ host, by: 'the organization' })),
    ...policies.filter((p) => p.action === 'block').flatMap((p) => p.destinations.map((host) => ({ host, by: `"${p.name}"` }))),
  ].flatMap((b) => blockHosts(b.host).map((host) => ({ ...b, host })))
  for (const p of policies) {
    if (p.action !== 'allow' || (p.advanced.enforcement !== 'audit' && !p.advanced.privateIps.length)) continue
    for (const d of p.destinations) {
      const hit = blocks.find((b) => overlapsBlocked([b.host], d))
      if (hit) throw fail(`"${p.name}" allows ${d} in audit mode or on private addresses, and ${hit.by} blocks ${hit.host}. OpenShell can't combine the two. Use Enforce and no private addresses, or drop the block.`)
    }
  }
}

// ---- storage ----------------------------------------------------------------

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

export async function readOrg() {
  const raw = await readJson(path.join(ORG_DIR, 'organization.json'))
  if (!raw) return { ...EMPTY_ORG }
  return { blocked: validateBlocked(raw.blocked), outside: 'block' }
}

function validateGroup(input) {
  const id = String(input.id ?? '').trim()
  if (!GROUP_ID.test(id)) throw fail('Group ids use lowercase letters, digits and dashes.')
  const outside = 'block'
  return {
    id,
    name: String(input.name ?? id).trim().slice(0, 80) || id,
    description: String(input.description ?? '').slice(0, 400),
    // A group may pin the security preset of sandboxes created in it. Groups
    // made in the console leave it to the launch dialog.
    template: input.template ? String(input.template) : null,
    outside,
  }
}

// Sandbox name → group id, or null for "no group", overriding the label.
export async function readMembers() {
  const raw = await readJson(MEMBERS_FILE)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  return Object.fromEntries(Object.entries(raw).filter(([name, id]) => SANDBOX_NAME.test(name) && (id === null || GROUP_ID.test(String(id)))))
}

// The group a sandbox is in. A stored membership wins over the creation
// label; a group that no longer exists counts as none.
export function groupOf(sandbox, members, groups) {
  const id = Object.hasOwn(members, sandbox.name) ? members[sandbox.name] : sandbox.labels?.[GROUP_LABEL] ?? null
  return id && groups.some((g) => g.id === id) ? id : null
}

// `group` null takes the sandboxes out of every group; `forget` drops the
// entries, for sandboxes that no longer exist.
export async function assignGroup(names, group, { forget = false } = {}) {
  const members = await readMembers()
  for (const name of names) {
    if (forget) delete members[name]
    else members[name] = group
  }
  await write(MEMBERS_FILE, Object.fromEntries(Object.entries(members).sort(([a], [b]) => a.localeCompare(b))))
  return members
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

export const effectiveOutside = () => 'block'

// The rules the console owns in a sandbox's policy, keyed by their policy name.
const managedRules = (org, policies, sandbox, openPorts) => compileFor(sandbox, policies, org.blocked, openPorts)

// The ports a sandbox's own rules open (template, one-off, provider). A block
// has to cover them, or a blocked host would stay reachable there.
const openPorts = (networkPolicies) => Object.entries(networkPolicies ?? {}).filter(([key]) => !isManaged(key))
  .flatMap(([, rule]) => (rule.endpoints ?? []).flatMap((e) => (e.ports?.length ? e.ports : e.port ? [e.port] : [])))

// An agent's reviewed destinations, as sandbox rules named agent-<id>. They
// are not managed rules: the pass leaves them alone, and a block still wins.
export function addAgentAccess(policy, agentRules, org) {
  assertNotBlocked(org, agentRules, 'Agent access')
  for (const spec of agentRules) {
    const { name, rule } = ruleToProto(spec)
    if (policy.networkPolicies[name]) throw fail(`Security preset rule "${name}" conflicts with required agent access. Rename that rule.`)
    policy.networkPolicies[name] = rule
  }
  return policy
}

// Everything a new sandbox needs from its group, resolved before it exists.
export async function planSandbox({ name, group: groupId, template: templateId, agentRules = [] }) {
  const [org, policies] = await Promise.all([readOrg(), listPolicies()])
  let group = null
  if (groupId) {
    group = await findGroup(groupId)
    if (!group) throw fail('Unknown group.')
  }
  const template = await findTemplate(group?.template || templateId || 'locked-down')
  if (!template) throw fail('Unknown policy template.')
  assertNotBlocked(org, template.rules, 'Template')
  const policy = templateToPolicy(template)
  addAgentAccess(policy, agentRules, org)
  Object.assign(policy.networkPolicies, managedRules(org, policies, { name, group: group?.id ?? null }, openPorts(policy.networkPolicies)))
  return {
    policy,
    template,
    labels: group ? { [GROUP_LABEL]: group.id } : {},
  }
}

// Gateway settings take precedence over sandbox overrides, including old auto settings.
export async function enforcePolicyOnly(client) {
  const current = await client.raw.getGatewayConfig({})
  for (const [key, kind, value] of [
    ['proposal_approval_mode', 'stringValue', 'manual'],
    ['agent_policy_proposals_enabled', 'boolValue', false],
  ]) {
    if (current.settings?.[key]?.value?.value === value) continue
    await client.raw.updateConfig({ global: true, settingKey: key, settingValue: { value: { case: kind, value } }, requestId: randomUUID() })
  }
}

// The operations that bring one sandbox's managed rules in line with the
// stored policies. `extraPorts` are ports the same update is about to open.
async function managedOps(client, sandbox, org, groups, policies, members, extraPorts = []) {
  const groupId = groupOf(sandbox, members, groups)
  const group = groupId ? groups.find((g) => g.id === groupId) ?? null : null
  const status = await client.raw.getSandboxPolicyStatus({ sandbox: sandbox.name, workspaceScope: WORKSPACE })
  const rules = status.revision?.policy?.networkPolicies ?? {}
  const desired = managedRules(org, policies, { name: sandbox.name, group: group?.id ?? null }, [...openPorts(rules), ...extraPorts])
  const current = Object.keys(rules).filter(isManaged)
  const same = current.length === Object.keys(desired).length && current.every((k) => k in desired)
  const ops = [
    ...current.map((ruleName) => ({ operation: { case: 'removeRule', value: { ruleName } } })),
    ...Object.entries(desired).map(([ruleName, rule]) => ({ operation: { case: 'addRule', value: { ruleName, rule } } })),
  ]
  return { ops, same, group }
}

// For a one-off rule edit that opens new ports: the managed rules recomputed
// with those ports, to go in the same update as the edit.
export async function managedOpsFor(client, name, extraPorts) {
  const [org, groups, policies, members, sandbox] = await Promise.all([readOrg(), listGroups(), listPolicies(), readMembers(), client.raw.getSandbox({ name, workspaceScope: WORKSPACE })])
  return (await managedOps(client, sandboxView(sandbox.sandbox), org, groups, policies, members, extraPorts)).ops
}

// Rewrites the managed rules of one sandbox to match the stored policy. The
// sandbox's own rules are never touched.
async function syncOne(client, sandbox, org, groups, policies, members, { force = true } = {}) {
  const { ops, same, group } = await managedOps(client, sandbox, org, groups, policies, members)
  if (!force && same) return { changed: false }
  let version = null
  if (ops.length) {
    const response = await client.raw.updateConfig({
      sandbox: sandbox.name, workspaceScope: WORKSPACE, global: false, mergeOperations: ops,
      annotations: { 'console.openshell/change': `org-sync:${group ? `group=${group.id}` : 'org'}` },
      requestId: randomUUID(),
    })
    version = response.version
  }
  return { changed: true, version }
}

async function liveSandboxes(client) {
  const response = await client.raw.listSandboxes({ workspaceScope: WORKSPACE })
  return response.sandboxes.map(sandboxView).filter((s) => s.phase !== 'deleting')
}

// `only` narrows the pass to the sandboxes a change can reach.
export async function syncAll({ group: onlyGroup = null, only = null, force = true } = {}) {
  const { client } = await gateway()
  const [org, groups, policies, members, live] = await Promise.all([readOrg(), listGroups(), listPolicies(), readMembers(), liveSandboxes(client)])
  const sandboxes = live.map((s) => ({ ...s, group: groupOf(s, members, groups) }))
  const targets = sandboxes.filter((s) => (!onlyGroup || s.group === onlyGroup) && (!only || only(s)))
  const results = await Promise.all(targets.map(async (s) => {
    try { return { sandbox: s.name, ...(await syncOne(client, s, org, groups, policies, members, { force })) } } catch (error) { return { sandbox: s.name, error: error.rawMessage ?? error.message } }
  }))
  return {
    applied: results.filter((r) => r.changed).map((r) => r.sandbox),
    failed: results.filter((r) => r.error).map(({ sandbox, error }) => ({ sandbox, error })),
  }
}

// Whether policy settles this request without a person, and why.
export function settledBy(org, group, hosts, sandbox = null, policies = []) {
  const hit = blockedBy(org, hosts)
  if (hit) return `Blocked by organization policy (${hit.pattern}).`
  const byPolicy = sandbox && blockedByPolicy(policies, { name: sandbox, group: group?.id ?? null }, hosts, hostMatches)
  if (byPolicy) return `Blocked by egress policy "${byPolicy.policy.name}".`
  if (effectiveOutside(org, group) === 'block') return 'No egress policy allows it. Add one on the Egress page to allow it.'
  return null
}

// Reconcile configured rules. Legacy proposals are rejected, never approved;
// historical grants to explicitly blocked hosts are revoked as before.
async function sweep(log) {
  const { client } = await gateway()
  await enforcePolicyOnly(client)
  const [org, groups, policies, members, sandboxes] = await Promise.all([readOrg(), listGroups(), listPolicies(), readMembers(), liveSandboxes(client)])
  for (const s of sandboxes) {
    const group = groups.find((g) => g.id === groupOf(s, members, groups)) ?? null
    try {
      const result = await syncOne(client, s, org, groups, policies, members, { force: false })
      if (result.changed) log(`applied organization policy to ${s.name}`)
    } catch { /* retried next pass */ }
    let draft
    try { draft = await client.raw.getDraftPolicy({ sandbox: s.name, workspaceScope: WORKSPACE }) } catch { continue }
    for (const chunk of draft.chunks) {
      const hosts = (chunk.proposedRule?.endpoints ?? []).map((e) => e.host)
      const hit = blockedBy(org, hosts)
      const reason = settledBy(org, group, hosts, s.name, policies)
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
  const [org, groups, policies, stored, sandboxes] = await Promise.all([readOrg(), listGroups(), listPolicies(), readMembers(), liveSandboxes(client)])
  const members = Object.fromEntries(groups.map((g) => [g.id, []]))
  const assignments = {}
  const ungrouped = []
  for (const s of sandboxes) {
    const id = groupOf(s, stored, groups)
    assignments[s.name] = id
    if (id) members[id].push(s.name)
    else ungrouped.push(s.name)
  }
  return { org, groups, policies, members, assignments, ungrouped, total: sandboxes.length }
}

// Moves sandboxes into a group, or out of every group, and applies the
// policies that now reach them.
async function setMembers(input) {
  const names = [...new Set((Array.isArray(input.sandboxes) ? input.sandboxes : []).map(String))]
  if (!names.length) throw fail('Pick at least one sandbox.')
  for (const n of names) if (!SANDBOX_NAME.test(n)) throw fail(`"${n}" is not a sandbox name.`)
  const group = input.group ? String(input.group) : null
  if (group && !(await findGroup(group))) throw fail('Unknown group.')
  await assignGroup(names, group)
  return { group, ...(await syncAll({ only: (s) => names.includes(s.name) })) }
}

async function saveOrg(input) {
  const org = { blocked: validateBlocked(input.blocked), outside: 'block' }
  assertCompatible(org, await listPolicies())
  await write(path.join(ORG_DIR, 'organization.json'), org)
  return { org, ...(await syncAll()) }
}

async function saveGroup(input) {
  const group = validateGroup(input)
  if (input.isNew && (await findGroup(group.id))) throw fail(`A group with the id "${group.id}" already exists. Pick another name.`)
  if (group.template && !(await findTemplate(group.template))) throw fail('Unknown policy template.')
  await write(path.join(GROUP_DIR, `${group.id}.json`), group)
  return { group, ...(await syncAll({ group: group.id })) }
}

async function savePolicy(input) {
  const policy = validatePolicy(input)
  const [org, groups, policies] = await Promise.all([readOrg(), listGroups(), listPolicies()])
  if (input.isNew && policies.some((p) => p.id === policy.id)) throw fail(`A policy with the id "${policy.id}" already exists. Pick another name.`)
  const unknown = policy.appliesTo.groups.find((g) => !groups.some((x) => x.id === g))
  if (unknown) throw fail(`Unknown group "${unknown}".`)
  assertCompatible(org, [...policies.filter((p) => p.id !== policy.id), policy])
  const before = policies.find((p) => p.id === policy.id)
  await writePolicy(policy)
  return { policy, ...(await syncAll({ only: covers([before, policy]) })) }
}

async function deletePolicy(id) {
  const before = (await listPolicies()).find((p) => p.id === id)
  await removePolicy(id)
  return { ok: true, ...(await syncAll({ only: covers([before]) })) }
}

// The sandboxes an old or new version of a policy applies to.
const covers = (versions) => (s) => versions.some((p) => p && appliesTo(p, { name: s.name, group: s.group }))

async function deleteGroup(id) {
  if (!GROUP_ID.test(id)) throw fail('Unknown group.')
  const { members } = await overview()
  const left = members[id] ?? []
  // Its sandboxes leave the group rather than blocking the delete. Stored as
  // "no group", so a creation label can't pull them back in.
  if (left.length) await assignGroup(left, null)
  await fs.rm(path.join(GROUP_DIR, `${id}.json`), { force: true })
  // A later group with the same id must not inherit this one's policies.
  for (const p of await listPolicies()) {
    if (p.appliesTo.groups.includes(id)) await writePolicy({ ...p, appliesTo: { ...p.appliesTo, groups: p.appliesTo.groups.filter((g) => g !== id) } })
  }
  return { ok: true, ...(left.length ? await syncAll({ only: (s) => left.includes(s.name) }) : { applied: [], failed: [] }) }
}

export async function orgRoute(method, parts, input) {
  const [area, a, b, c] = parts
  if (area === 'egress' && method === 'POST' && a === 'policies') {
    if (!b) return savePolicy(input)
    if (c === 'delete') return deletePolicy(b)
    return undefined
  }
  if (area !== 'org') return undefined
  if (method === 'GET' && !a) return overview()
  if (method !== 'POST') return undefined
  if (!a) return saveOrg(input)
  if (a === 'sync') return syncAll()
  if (a === 'groups' && !b) return saveGroup(input)
  if (a === 'members') return setMembers(input)
  if (a === 'groups' && b && c === 'delete') return deleteGroup(b)
  return undefined
}
