import { activityRow, filterActivity } from './activity-inventory.js'
import { resourceKey } from './locations.js'

// Page each source at its own snapshot, then merge. Names and event ids are
// only unique within a source; mutation plans retain that source throughout.
export function combinedActivityApi(base, getLocations, apiFor) {
  const cache = new Map(), plans = new Map()
  let sequence = 0
  return {
    ...base,
    async activity(options = {}) {
      const { offset = 0, limit = 50, snapshot = {}, exportAll, ...query } = options
      const now = query.now ?? Date.now()
      const {now: queryNow, ...filters} = query
      const key = JSON.stringify(filters)
      const entries = await Promise.all(getLocations().map(async location => {
        const identity = location.id ?? location.context
        const cacheKey = `${identity}:${key}`
        const prior = cache.get(cacheKey)
        if (!location.connected) return prior ? {...prior, total:prior.events.length, events: prior.events.map(event => ({...event, location}))} : null
        try {
          const events = []; let result, sourceOffset = 0, sourceSnapshot = snapshot?.[identity]
          const needed = exportAll ? Infinity : offset + limit
          do {
            result = await apiFor(location).activity({...query, now, offset: sourceOffset, limit: Math.min(1000, needed - sourceOffset), ...(sourceSnapshot != null ? {snapshot: sourceSnapshot} : {})})
            sourceSnapshot = result.snapshot
            events.push(...result.events.map(event => ({...event, originalId: event.id, id: resourceKey({id: event.id, location}), location})))
            sourceOffset += result.events.length
          } while (sourceOffset < needed && sourceOffset < result.total && result.events.length)
          const entry = {...result, events, identity, snapshot: sourceSnapshot}
          cache.set(cacheKey, entry)
          return entry
        } catch (error) {
          if (prior) return {...prior, total:prior.events.length, events: prior.events.map(event => ({...event, location: {...location, connected: false}}))}
          return {error}
        }
      }))
      const available = entries.filter(entry => entry && !entry.error)
      if (!available.length && entries.some(entry => entry?.error)) throw entries.find(entry => entry?.error).error
      const merged = filterActivity(available.flatMap(entry => entry.events).map(activityRow), {...query, now}).map(row => row.event)
      const total = available.reduce((sum, entry) => sum + entry.total, 0)
      return {events: exportAll ? merged : merged.slice(offset, offset + limit), total, now,
        snapshot: Object.fromEntries(available.map(entry => [entry.identity, entry.snapshot])),
        sandboxes: [...new Set(available.flatMap(entry => entry.sandboxes ?? []))], agents: [...new Set(available.flatMap(entry => entry.agents ?? []))],
        nextOffset: offset + limit < total ? offset + limit : null}
    },
    async previewActivityDeletion({mode, ids = [], query}) {
      const locations = getLocations()
      const owners = locations.filter(location => mode !== 'selected' || ids.some(id => { try {return JSON.parse(id)[0][0] === (location.target ?? 'local') && JSON.parse(id)[0][1] === location.context} catch {return false} }))
      if (mode === 'selected' && owners.some(location => !location.connected)) throw new Error('Reconnect the source of the selected logs before deleting them.')
      const entries = []
      for (const location of owners.filter(location => location.connected)) {
        const originalIds = ids.filter(id => {try {const [owner] = JSON.parse(id);return owner[0] === (location.target ?? 'local') && owner[1] === location.context} catch {return false}}).map(id => JSON.parse(id)[1])
        const plan = await apiFor(location).previewActivityDeletion({mode, ...(mode === 'selected' ? {ids: originalIds} : {}), query})
        entries.push({location, plan})
      }
      const token = `combined:${++sequence}`
      plans.set(token, {entries, deleted: 0})
      return {token, mode, count: entries.reduce((sum, entry) => sum + entry.plan.count, 0), expiresAt: entries.length ? Math.min(...entries.map(entry => entry.plan.expiresAt)) : Date.now(), skipped: owners.filter(location => !location.connected).map(location => location.label)}
    },
    async deleteActivity(token) {
      const plan = plans.get(token)
      if (!plan) throw new Error('Review the log deletion again.')
      // Remove successful entries so retrying a partial failure never repeats it.
      while (plan.entries.length) {
        const entry = plan.entries[0]
        const result = await apiFor(entry.location).deleteActivity(entry.plan.token)
        plan.deleted += result.deleted; plan.entries.shift()
      }
      plans.delete(token)
      return {deleted: plan.deleted}
    },
  }
}
