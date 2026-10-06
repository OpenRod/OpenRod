// With only one reachable place to put it, a new resource goes straight there.
// Any other location (a Remote, connected or saved, or Cloud) keeps the choice.
export function directLocation(locations) {
  const [only] = locations
  return locations.length === 1 && !only.remote && only.connected ? only : null
}
