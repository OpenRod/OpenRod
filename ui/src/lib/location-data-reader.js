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
    return { location: errors.length && errors.length === methods.length ? { ...location, connected: false } : location, data: Object.keys(data).length ? data : null, error: errors.join('; ') || null }
  }))
}
