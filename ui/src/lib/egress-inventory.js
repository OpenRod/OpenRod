import { sourceOf,hostOf,isIp,portOf } from './policy-sources.js'
import { blockPatterns,hostMatches } from './egress.js'
import { resourceKey } from './locations.js'

export function egressRows(sandboxes, events, org) {
    const dest = new Map()
    const allowedBy = new Map()
    const perSandbox = new Map()
    for (const s of sandboxes) {
      const hosts = new Set()
      const counts = {}
      for (const r of s.rules) {
        const src = sourceOf(r.key)
        counts[src] = (counts[src] ?? 0) + 1
        for (const e of r.endpoints) {
          if (e.blocked) continue
          hosts.add(e.host)
          const d = dest.get(e.host) ?? { host: e.host, sources: new Set(), access: new Set(), ports: new Set(), sandboxes: new Set(), grants: [], hits: 0, hitsBySandbox: new Map() }
          d.sources.add(src); d.access.add(e.access); e.ports.forEach((p) => d.ports.add(p)); d.sandboxes.add(s.name)
          let grant = d.grants.find((g) => g.sandbox === s.name && g.key === r.key)
          if (!grant) {
            grant = { sandbox: s.name, key: r.key, source: src, access: [], ports: [] }
            d.grants.push(grant)
          }
          grant.access.push(e.access)
          grant.ports.push(...e.ports)
          dest.set(e.host, d)
        }
      }
      allowedBy.set(s.name, hosts)
      perSandbox.set(s.name, { counts, blocked: 0 })
    }
    const block = new Map()
    for (const e of events) {
      if (e.kind !== "audit" || !e.verdict) continue
      const host = hostOf(e.destination)
      if (!host || isIp(host)) continue
      if (e.verdict === "allowed") { const d = dest.get(host); if (d) { d.hits += 1; d.hitsBySandbox.set(e.sandbox, (d.hitsBySandbox.get(e.sandbox) ?? 0) + 1) }; continue }
      if (e.verdict !== "denied" || allowedBy.get(e.sandbox)?.has(host)) continue
      const b = block.get(host) ?? { host, port: portOf(e.destination), sandboxes: new Set(), attempts: 0, programs: new Set(), lastAt: null }
      b.attempts += 1; b.sandboxes.add(e.sandbox)
      if (e.binary) b.programs.add(e.binary)
      if (e.at && (!b.lastAt || e.at > b.lastAt)) b.lastAt = e.at
      block.set(host, b)
      const p = perSandbox.get(e.sandbox); if (p) p.blocked += 1
    }
    // Hosts a block already decides are not waiting for anyone.
    const decided = blockPatterns([...(org?.org?.blocked ?? []), ...(org?.policies ?? []).filter((p) => p.action === "block").flatMap((p) => p.destinations)])
    return {
      destinations: [...dest.values()].sort((a, b) => b.sandboxes.size - a.sandboxes.size || b.hits - a.hits || a.host.localeCompare(b.host)),
      blocked: [...block.values()].filter((b) => !decided.some((pattern) => hostMatches(pattern, b.host))).sort((a, b) => b.sandboxes.size - a.sandboxes.size || b.attempts - a.attempts),
      perSandbox,
    }
}

export function combinedEgressInventory(sources) {
  const inventories=sources.map(source=>({location:source.location,...egressRows(source.data?.fleetPolicy?.sandboxes ?? [],source.data?.activity?.events ?? [],source.data?.org)}))
  return {
    destinations:inventories.flatMap(source=>source.destinations.map(row=>({...row,location:source.location}))),
    blocked:inventories.flatMap(source=>source.blocked.map(row=>({...row,location:source.location}))),
    perSandbox:new Map(inventories.flatMap(source=>[...source.perSandbox].map(([name,row])=>[resourceKey({name,location:source.location}),row]))),
  }
}
