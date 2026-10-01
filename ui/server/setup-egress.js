import { DEFAULT_ADVANCED, listPolicies, removePolicy, validatePolicy, writePolicy } from './egress.js'
import { blockOverlap, covers, protectCoverage, readOrg, serializeOrgWrite, syncAllWhileLocked } from './org.js'
import { readSetupMembers } from './setup-members.js'
import { usableSetup, SETUP_ID } from './setups.js'
import { hostMatches } from '../src/lib/egress.js'
import { inSetupPolicy } from '../src/lib/setup-network.js'

// ---- one egress policy per MCPs & Skills setup -------------------------------
//
// A saved setup whose MCPs reach the network gets one allow policy,
// policies/egress/setup-<id>.json, that applies to the sandboxes using the
// setup (server/setup-members.js). It lists the hosts the setup's MCPs reach
// at runtime and their own sign-in hosts, never build hosts such as the npm
// registry: the isolated builder reaches those, not sandboxes. Hosts an MCP
// sends credentials to, and sign-in services an MCP's metadata names, stay out
// too: each sandbox approves those when it enables the setup. Hosts the
// organization blocks stay out. People may add hosts and ports in Egress; a
// recompute keeps them.

const fail = (message, status = 400) => Object.assign(new Error(message), { status })
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/
const PHASES = ['runtime', 'auth']
const NONE = { applied: [], failed: [] }
const uniq = (items) => [...new Set(items)]

export const setupPolicyId = (setupId) => {
  if (!SETUP_ID.test(String(setupId ?? ''))) throw fail('Unknown MCPs & Skills setup.')
  return `setup-${setupId}`
}

// Host and port → the MCPs that need them, in the order the setup lists them.
function hostsOf(setup, keep) {
  const out = new Map()
  for (const item of usableSetup(setup).items) for (const r of item.requirements ?? []) {
    const host = String(r.host ?? '').trim().toLowerCase().replace(/\.$/, ''), port = Number(r.port ?? 443)
    if (!PHASES.includes(r.phase) || !keep(item, r) || !HOST.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) continue
    const entry = out.get(`${host}:${port}`) ?? { host, port, items: [] }
    if (!entry.items.includes(item.name)) entry.items.push(item.name)
    out.set(`${host}:${port}`, entry)
  }
  return [...out.values()]
}
export const setupHosts = (setup) => hostsOf(setup, inSetupPolicy)
// The hosts each sandbox approves when it enables the setup instead.
export const approvalHosts = (setup) => hostsOf(setup, (item, r) => !inSetupPolicy(item, r))
const byHost = (needs) => [...needs.reduce((all, { host, items }) => all.set(host, { host, items: uniq([...(all.get(host)?.items ?? []), ...items]) }), new Map()).values()]
// Only an allow policy carrying this setup's marker is the setup's to rewrite or delete.
const owned = (policy, setupId) => policy?.action === 'allow' && policy.setup?.id === setupId

// The setup's own allow policy when it lets a sandbox using the setup (or the
// setup a Quick-setup snapshot was prepared from) reach the requirement.
export const setupPolicyFor = (policies, setup, requirement) => {
  const ids = [setup.id, setup.preparedFrom?.id].filter(Boolean)
  return policies.find((p) => p.action === 'allow' && (p.appliesTo.setups ?? []).some((id) => ids.includes(id))
    && p.destinations.some((d) => hostMatches(d, requirement.host)) && p.advanced.ports.includes(Number(requirement.port ?? 443))) ?? null
}

// `dir`, `org`, `sync` and `members` are for tests.
export function createSetupEgress({ dir, org = readOrg, sync = syncAllWhileLocked, members = readSetupMembers } = {}) {
  // Automatic and manual changes share coverage checks and the same queue.
  const serial = serializeOrgWrite
  // Only the sandboxes either version reaches. Without any, the gateway is
  // not contacted; when it is unreachable, the sweeper applies it later.
  async function apply(versions) {
    try {
      const stored = Object.values(await members())
      const reach = versions.some((p) => p && (p.appliesTo.everyone || p.appliesTo.groups.length || p.appliesTo.sandboxes.length || stored.some((ids) => p.appliesTo.setups.some((id) => ids.includes(id)))))
      return reach ? await sync({ only: covers(versions) }) : NONE
    } catch (error) { return { error: error.rawMessage ?? error.message } }
  }
  const syncSetupPolicy = (setup) => serial(async () => {
    if (!SETUP_ID.test(String(setup?.id ?? '')) || !Array.isArray(setup.items) || typeof setup.name !== 'string') throw fail('Unknown MCPs & Skills setup.')
    // A Quick-setup snapshot uses the policy of the setup it was prepared from.
    if (setup.preparedFrom) return null
    const id = setupPolicyId(setup.id)
    const [organization, policies] = await Promise.all([org(), listPolicies(dir)])
    const existing = policies.find((p) => p.id === id) ?? null
    // A rule switched to Block in Egress, or someone else's rule with this id, is left alone.
    if (existing && !owned(existing, setup.id)) throw fail(`The rule “${existing.name}” isn’t an allow rule kept by this setup, so it was left unchanged. Edit it in Network › Egress.`, 409)
    const advanced = existing?.advanced ?? { ...DEFAULT_ADVANCED, ports: [] }
    // OpenShell can't combine an audit or private-address allow with any block
    // on the same host, so such a policy keeps clear of every block.
    const strict = advanced.enforcement === 'audit' || advanced.privateIps.length > 0
    const blocks = [...organization.blocked, ...policies.filter((p) => p.action === 'block' && (strict || p.appliesTo.everyone)).flatMap((p) => p.destinations)]
    const hosts = new Map(), blocked = [], ports = []
    for (const need of setupHosts(setup)) {
      if (blockOverlap(blocks, need.host)) { if (!blocked.includes(need.host)) blocked.push(need.host); continue }
      ports.push(need.port)
      const entry = hosts.get(need.host) ?? { host: need.host, items: [] }
      entry.items = uniq([...entry.items, ...need.items])
      hosts.set(need.host, entry)
    }
    const required = [...hosts.keys()]
    const extras = (existing?.destinations ?? []).filter((d) => !(existing.setup?.required ?? []).includes(d) && !required.includes(d))
    const destinations = [...required, ...extras]
    if (!destinations.length) {
      if (existing) {
        await protectCoverage(policies, policies.filter((p) => p.id !== id))
        await removePolicy(id, dir); await apply([existing])
      }
      return null
    }
    // Ports people added stay; ports only a removed MCP needed close.
    const opened = uniq([...advanced.ports.filter((p) => !(existing?.setup?.ports ?? []).includes(p)), ...ports])
    const policy = validatePolicy({
      id,
      name: existing?.name ?? `MCPs & Skills: ${setup.name}`.slice(0, 80),
      action: 'allow',
      destinations,
      appliesTo: existing ? { ...existing.appliesTo, setups: uniq([...existing.appliesTo.setups, setup.id]) } : { everyone: false, groups: [], sandboxes: [], setups: [setup.id] },
      advanced: { ...advanced, ports: opened.length ? opened : DEFAULT_ADVANCED.ports },
      setup: { id: setup.id, name: setup.name.replace(/[\x00-\x1f\x7f]/g, ''), required, ports: uniq(ports) },
    })
    const changed = JSON.stringify(policy) !== JSON.stringify(existing)
    if (changed) {
      await protectCoverage(policies, [...policies.filter((p) => p.id !== id), policy])
      await writePolicy(policy, dir)
    }
    return { id, name: policy.name, created: !existing, destinations: policy.destinations, hosts: [...hosts.values()], blocked, approval: byHost(approvalHosts(setup)), sync: changed ? await apply([existing, policy]) : NONE }
  })
  const removeSetupPolicy = (setupId) => serial(async () => {
    const id = setupPolicyId(setupId)
    const policies = await listPolicies(dir)
    const existing = policies.find((p) => p.id === id)
    if (!owned(existing, setupId)) return { removed: false, sync: NONE }
    await protectCoverage(policies, policies.filter((p) => p.id !== id))
    await removePolicy(id, dir)
    return { removed: true, sync: await apply([existing]) }
  })
  return { syncSetupPolicy, removeSetupPolicy }
}

export const { syncSetupPolicy, removeSetupPolicy } = createSetupEgress()
