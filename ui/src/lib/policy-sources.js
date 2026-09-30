// Where an egress rule comes from decides who may change it. The prefixes are
// written by the gateway (_provider_) and by the Organization page (org_, group_).
export const SOURCE = {
  own: { label: "Sandbox", swatch: "bg-stone-700", beam: ["#a8a29e", "#44403c"] },
  agent: { label: "Agent defaults", swatch: "bg-indigo-500", beam: ["#a5b4fc", "#6366f1"] },
  org: { label: "Shared", swatch: "bg-[#4a5568]", beam: ["#94a3b8", "#4a5568"] },
  group: { label: "Inherited", swatch: "bg-teal-600", beam: ["#5eead4", "#0f766e"] },
  secret: { label: "Secret", swatch: "bg-amber-600", beam: ["#fcd34d", "#b45309"] },
}
export const SOURCE_ORDER = ["org", "group", "agent", "own", "secret"]

export const sourceOf = (key) => (key.startsWith("_provider_") ? "secret" : key.startsWith("org_") ? "org" : key.startsWith("group_") ? "group" : key.startsWith("agent-") ? "agent" : "own")
export const displayName = (key) => key.replace(/^_provider_/, "").replace(/^(org|group)_/, "").replace(/_/g, "-")

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
