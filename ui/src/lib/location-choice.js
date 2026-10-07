// With only one reachable place to put it, a new resource goes straight there.
// Any other location (a Remote, connected or saved, or Cloud) keeps the choice,
// as does an OpenRod Cloud this console can connect but has not yet.
export function directLocation(locations, { offerCloud = false } = {}) {
  const [only] = locations
  return locations.length === 1 && !only.remote && only.connected && !offerCloud ? only : null
}
