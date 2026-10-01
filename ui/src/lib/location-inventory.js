// A gateway context may have the same name on separate machines. Include the
// compute target when merging inventories and use the original context for API
// calls; the server remains the authority for location availability.
export function mergeLocationInventories(sources) {
  const result = { locations: [], sandboxes: [], templates: [] }
  for (const { target, inventory, cloud = target === 'cloud' } of sources) {
    const owners = new Map((inventory.locations ?? []).map(location => {
      const owner = { ...location, target, cloud, id: JSON.stringify([target, location.context]), ...(cloud ? { label: 'Cloud' } : {}) }
      result.locations.push(owner)
      return [location.context, owner]
    }))
    for (const kind of ['sandboxes', 'templates']) {
      for (const record of inventory[kind] ?? []) {
        const location = owners.get(record.location?.context)
        if (location) result[kind].push({ ...record, location })
      }
    }
  }
  return result
}
