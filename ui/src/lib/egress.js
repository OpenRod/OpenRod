// Network rule helpers shared by the server (server/egress.js, server/org.js)
// and the Network page, so coverage shown in the browser matches what the
// server writes into each sandbox.

// A policy reaches every sandbox, the sandboxes in its groups, or named ones.
export const appliesTo = (policy, sandbox) => policy.appliesTo.everyone
  || (sandbox.group != null && policy.appliesTo.groups.includes(sandbox.group))
  || policy.appliesTo.sandboxes.includes(sandbox.name)

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
