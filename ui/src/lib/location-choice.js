// Without a Remote (connected or saved) there is nothing to choose: a new
// resource goes straight to the location the picker would offer first.
export function directLocation(locations) {
  if (locations.some(location => location.remote)) return null
  const local = locations.find(location => !location.remote)
  return local?.connected ? local : null
}
