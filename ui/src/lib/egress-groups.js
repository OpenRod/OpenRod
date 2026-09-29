// Scope every displayed value to the sandboxes in this group. A destination
// shared by two groups can have different access, sources, ports and traffic.
export function groupDestinations(destinations, query = "", sourceFilter = "all") {
  const needle = query.trim().toLowerCase()
  const groups = new Map()
  for (const destination of destinations) {
    for (const group of destination.groups) {
      const grants = destination.grants.filter((grant) => grant.groupId === group.id)
      const sources = new Set(grants.map((grant) => grant.source))
      if (sourceFilter !== "all" && !sources.has(sourceFilter)) continue
      if (needle && ![destination.host, group.name, ...grants.flatMap((grant) => [grant.sandbox, grant.key])].join(" ").toLowerCase().includes(needle)) continue
      const sandboxes = new Set(grants.map((grant) => grant.sandbox))
      const scoped = {
        ...destination, groups: [group], grants, sandboxes, sources,
        access: new Set(grants.flatMap((grant) => grant.access)),
        ports: new Set(grants.flatMap((grant) => grant.ports)),
        hits: [...sandboxes].reduce((sum, name) => sum + (destination.hitsBySandbox.get(name) ?? 0), 0),
      }
      if (!groups.has(group.id)) groups.set(group.id, { ...group, destinations: [] })
      groups.get(group.id).destinations.push(scoped)
    }
  }
  return [...groups.values()].sort((a, b) => a.id === null ? 1 : b.id === null ? -1 : a.name.localeCompare(b.name))
}
