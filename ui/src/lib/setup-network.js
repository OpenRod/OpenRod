import { hostMatches } from './egress.js'

// Each saved setup gets one managed allow policy (server/setup-egress.js). A
// Quick-setup snapshot uses the policy of the setup it was prepared from.
export const setupPolicies = (policies, setup) => (policies ?? []).filter(p => p.action === 'allow' && (p.appliesTo?.setups ?? []).some(id => id === setup.id || id === setup.preparedFrom?.id))
// Narrowed in Egress (programs, request rules, private addresses), a policy no longer settles access on its own; the server then asks for a grant.
const unrestricted = (a = {}) => !a.programs?.length && (a.requests ?? 'any') === 'any' && !a.deny?.length && !a.privateIps?.length
export const coveredBySetupPolicy = (policies, setup, r) => setupPolicies(policies, setup).some(p => unrestricted(p.advanced) && (p.advanced?.ports ?? [443, 80]).map(Number).includes(Number(r.port ?? 443)) && p.destinations.some(d => hostMatches(d, r.host)))

// The policy opens an MCP's runtime hosts and its own sign-in host. An MCP
// that sends credentials, and sign-in services named by an MCP's metadata,
// are approved for each sandbox instead, when the setup is enabled there.
export const credentialed = (item) => Boolean(item.credentialRef || item.credentialFields?.length)
const same = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase()
export const inSetupPolicy = (item, r) => !credentialed(item) && (r.phase === 'runtime' || (r.phase === 'auth' && (item.requirements ?? []).some(o => o.phase === 'runtime' && same(o.host, r.host))))

const hostPort = (r) => `${r.host}${Number(r.port ?? 443) === 443 ? '' : `:${r.port}`}`
export const accessLabel = (r) => `${hostPort(r)}${r.path || ''}`
// The runtime and sign-in hosts of the chosen setups, split into those their
// egress policies already allow and those that still need approval. Without
// policies (they failed to load), every host needs approval. Policies open
// whole hosts, so covered ones are listed by host.
export function setupAccess(setups, policies, itemsOf, requirementsOf = item => item.requirements ?? []) {
  const covered = new Set(), uncovered = new Map()
  for (const setup of setups) for (const item of itemsOf(setup)) for (const r of requirementsOf(item).filter(r => ['runtime', 'auth'].includes(r.phase))) {
    if (policies && !(r.phase === 'runtime' && credentialed(item)) && coveredBySetupPolicy(policies, setup, r)) covered.add(hostPort(r))
    else uncovered.set(accessLabel(r), hostPort(r))
  }
  const pending = new Set(uncovered.values())
  return { covered: [...covered].filter(host => !pending.has(host)), uncovered: [...uncovered.keys()] }
}

// One row per website the saved policy allows, with the MCPs that need it.
// Websites added by hand have no MCP.
export function policyRows(policy) {
  const hosts = policy?.hosts ?? []
  const names = (host) => [...new Set(hosts.filter(h => h.host === host).flatMap(h => h.items ?? []))]
  return [...new Set(policy?.destinations ?? hosts.map(h => h.host))].filter(host => !policy?.blocked?.includes(host)).map(host => ({ host, items: names(host) }))
}
