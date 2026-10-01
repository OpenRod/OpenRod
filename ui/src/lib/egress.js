import { groupIds } from "../../shared/group-membership.js"

// Network rule helpers shared by the server (server/egress.js, server/org.js)
// and the Network page, so coverage shown in the browser matches what the
// server writes into each sandbox.

// A policy reaches every sandbox, the sandboxes in its groups, named ones, or
// the sandboxes that use one of its MCPs & Skills setups.
export const appliesTo = (policy, sandbox) => policy.appliesTo.everyone
  || groupIds(sandbox.groups ?? sandbox.group).some((id) => policy.appliesTo.groups.includes(id))
  || policy.appliesTo.sandboxes.includes(sandbox.name)
  || (policy.appliesTo.setups ?? []).some((id) => (sandbox.setups ?? []).includes(id))

// Blocking example.com also blocks its subdomains. OpenShell rejects `**.com`,
// so a bare top-level name stays exact.
export const blockHosts = (host) => (host.startsWith("*") || !host.includes(".") ? [host] : [host, `**.${host}`])
export const blockPatterns = (hosts) => hosts.flatMap(blockHosts)

// `*.a.com` is one label deep, `**.a.com` any depth; otherwise exact.
export function hostMatches(pattern, host) {
  host = String(host ?? "").toLowerCase()
  if (pattern.startsWith("**.")) return host.endsWith(pattern.slice(2))
  if (pattern.startsWith("*.")) {
    const rest = pattern.slice(1)
    return host.endsWith(rest) && !host.slice(0, -rest.length).includes(".") && host.length > rest.length
  }
  return host === pattern
}
