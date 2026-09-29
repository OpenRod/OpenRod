// Where an egress rule comes from decides who may change it. The prefixes are
// written by the gateway (_provider_), by egress policies (egress_) and for the
// shared blocked hosts (org_; group_ is from before egress policies).
export const SOURCE = {
  own: { label: "Sandbox", swatch: "bg-stone-700", beam: ["#a8a29e", "#44403c"] },
  org: { label: "Shared", swatch: "bg-[#4a5568]", beam: ["#94a3b8", "#4a5568"] },
  group: { label: "Inherited", swatch: "bg-teal-600", beam: ["#5eead4", "#0f766e"] },
  policy: { label: "Policy", swatch: "bg-indigo-600", beam: ["#a5b4fc", "#4338ca"] },
  secret: { label: "Secret", swatch: "bg-amber-600", beam: ["#fcd34d", "#b45309"] },
}
export const SOURCE_ORDER = ["org", "policy", "group", "own", "secret"]

export const sourceOf = (key) => (key.startsWith("_provider_") ? "secret" : key.startsWith("egress_") ? "policy" : key.startsWith("org_") ? "org" : key.startsWith("group_") ? "group" : "own")
export const displayName = (key) => key.replace(/^_provider_/, "").replace(/^(org|group|egress)_/, "").replace(/_/g, "-")

// `*.a.com` is one label deep, `**.a.com` any depth; otherwise exact. Same as the server.
export function hostMatches(pattern, host) {
  host = String(host ?? "").toLowerCase()
  if (pattern.startsWith("**.")) return host.endsWith(pattern.slice(2))
  if (pattern.startsWith("*.")) {
    const rest = pattern.slice(1)
    return host.endsWith(rest) && !host.slice(0, -rest.length).includes(".") && host.length > rest.length
  }
  return host === pattern
}

export function hostOf(d) {
  if (!d) return null
  try { return new URL(d.includes('://') ? d : `https://${d}`).hostname } catch { return d.split('/')[0].replace(/:\d+$/, '') }
}
export function portOf(d) {
  try { const url = new URL(d.includes('://') ? d : `https://${d}`); return Number(url.port) || (url.protocol === 'http:' ? 80 : 443) } catch { return 443 }
}
export const program = (path) => path.split("/").pop()
export const isIp = (host) => /^\d+\.\d+\.\d+\.\d+$/.test(host)

// The part of a host a person recognises: api.github.com → github.
export function brandOf(host) {
  const parts = String(host).replace(/^\*\*?\./, "").split(".")
  const core = parts.length >= 3 && ["co", "com", "org", "net", "ac", "gov"].includes(parts.at(-2)) ? parts.at(-3) : parts.at(-2) ?? parts[0]
  return core ?? host
}
