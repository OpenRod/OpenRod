// Where an egress rule comes from decides who may change it. The prefixes are
// written by the gateway (_provider_) and by the Organization page (org_, group_).
export const SOURCE = {
  own: { label: "Sandbox", swatch: "bg-stone-700", beam: ["#a8a29e", "#44403c"] },
  org: { label: "Shared", swatch: "bg-[#4a5568]", beam: ["#94a3b8", "#4a5568"] },
  group: { label: "Inherited", swatch: "bg-teal-600", beam: ["#5eead4", "#0f766e"] },
  secret: { label: "Secret", swatch: "bg-amber-600", beam: ["#fcd34d", "#b45309"] },
}
export const SOURCE_ORDER = ["org", "group", "own", "secret"]

export const sourceOf = (key) => (key.startsWith("_provider_") ? "secret" : key.startsWith("org_") ? "org" : key.startsWith("group_") ? "group" : "own")
export const displayName = (key) => key.replace(/^_provider_/, "").replace(/^(org|group)_/, "").replace(/_/g, "-")

export const hostOf = (d) => d?.split("/")[0]?.replace(/:\d+$/, "") ?? null
export const portOf = (d) => Number(/:(\d+)/.exec(d?.split("/")[0] ?? "")?.[1]) || 443
export const program = (path) => path.split("/").pop()
export const isIp = (host) => /^\d+\.\d+\.\d+\.\d+$/.test(host)

// The part of a host a person recognises: api.github.com → github.
export function brandOf(host) {
  const parts = String(host).replace(/^\*\*?\./, "").split(".")
  const core = parts.length >= 3 && ["co", "com", "org", "net", "ac", "gov"].includes(parts.at(-2)) ? parts.at(-3) : parts.at(-2) ?? parts[0]
  return core ?? host
}
