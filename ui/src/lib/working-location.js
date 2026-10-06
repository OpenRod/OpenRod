export const locationIdentity = location => location ? JSON.stringify([location.target ?? 'local', location.context]) : null

// A deep link owns its resources. Preserve that owner even if it goes offline;
// only an unscoped page may pick a reachable default, preferring this computer.
export function workingLocation(locations, requested, target = 'local') {
  if (requested) return locations.find(location => locationIdentity(location) === locationIdentity(requested)) ?? { ...requested, connected: false }
  return locations.find(location => location.target === target && !location.remote && location.connected)
    ?? locations.find(location => location.target === target && location.connected)
    ?? null
}
