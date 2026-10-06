// Read each source independently. A dead SSH host never prevents Local data
// from loading, and cached readings keep their original owner.
export async function readLocationData(locations, methods, apiFor, previous = []) {
  const cached = new Map(previous.map(source => [source.location.id ?? source.location.context, source.data]))
  return Promise.all(locations.map(async location => {
    const before = cached.get(location.id ?? location.context)
    if (!location.connected) return { location, data: before ?? null, error: null }
    const results = await Promise.allSettled(methods.map(method => apiFor(location)[method]()))
    const data = {}, errors = []
    results.forEach((result, i) => {
      if (result.status === 'fulfilled') data[methods[i]] = result.value
      else { if (before?.[methods[i]] !== undefined) data[methods[i]] = before[methods[i]]; errors.push(result.reason.message) }
    })
    return { location: errors.length && errors.length === methods.length ? { ...location, connected: false } : location, data: Object.keys(data).length ? data : null, error: [...new Set(errors)].join('; ') || null }
  }))
}

// Sources a combined page could not read: failed reads, and offline sources
// with nothing cached. Unavailable means no source has a full reading to show.
export function unreadSources(sources, methods) {
  const complete = source => methods.every(method => source.data?.[method] !== undefined)
  const failed = sources.filter(source => source.error)
  const offline = sources.filter(source => !source.error && !complete(source) && source.location.connected === false)
  return { failed, offline, any: failed.length + offline.length > 0, unavailable: sources.length > 0 && sources.every(source => !complete(source) && (source.error || source.location.connected === false)) }
}
