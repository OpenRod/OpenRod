import { activityRow, filterActivity, SEVERITY_RANK } from './activity-inventory.js'
import { locationLabel, resourceKey } from './locations.js'

// Each source pages in activity-store's ORDER BY, so the merge must use that exact
// order or page boundaries skip and repeat events. Keep these keys in step with it.
const SORTABLE = new Set(['time', 'sandbox', 'scope', 'sandboxId', 'agent', 'category', 'severity', 'logLevel', 'direction', 'verdict', 'outcome', 'process', 'action', 'destination', 'policy', 'session', 'correlation', 'why'])
// SQLite's BINARY collation compares UTF-8 bytes (code point order), not UTF-16 units.
const binary = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i < a.length && i < b.length ? a.codePointAt(i) - b.codePointAt(i) : a.length - b.length }
// json_extract yields NULL, a number (booleans as 0/1) or text, ordered in that sequence.
const sqlValue = value => typeof value === 'boolean' ? Number(value) : typeof value === 'number' ? (Number.isFinite(value) ? value : null) : value == null ? null : typeof value === 'object' ? JSON.stringify(value) : String(value)
const typeRank = value => value === null ? 0 : typeof value === 'number' ? 1 : 2
const compareSql = (a, b) => typeRank(a) - typeRank(b) || (typeof a === 'number' ? a - b : typeof a === 'string' ? binary(a, b) : 0)
const severityRank = value => { const name = String(value ?? '').replace(/[a-z]+/g, letters => letters.toUpperCase()); return Object.hasOwn(SEVERITY_RANK, name) ? SEVERITY_RANK[name] : -1 }
export function serverSort(rows, sort) {
  const key = SORTABLE.has(sort?.key) ? sort.key : 'time', direction = sort?.direction === 'asc' ? 1 : -1
  const value = row => key === 'time' ? (Number.isFinite(row.timestamp) ? row.timestamp : 0) : key === 'severity' ? severityRank(row.values.severity) : sqlValue(row.values[key])
  return rows.map(row => [value(row), row]).sort(([av, a], [bv, b]) => direction * compareSql(av, bv) || binary(String(a.event.originalId ?? a.event.id ?? ''), String(b.event.originalId ?? b.event.id ?? '')) || binary(a.key, b.key)).map(([, row]) => row)
}

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
      const locations = getLocations(), unavailable = []
      const entries = await Promise.all(locations.map(async (location, index) => {
        const identity = location.id ?? location.context
        const cacheKey = `${identity}:${key}`
        // An export must be complete, so it never substitutes a cached page.
        const prior = exportAll ? null : cache.get(cacheKey)
        if (!location.connected) { unavailable[index] = {label: locationLabel(location), offline: true}; return prior ? {...prior, total:prior.events.length, events: prior.events.map(event => ({...event, location}))} : null }
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
          if (!exportAll) cache.set(cacheKey, entry)
          return entry
        } catch (error) {
          unavailable[index] = {label: locationLabel(location), error: error.message}
          if (prior) return {...prior, total:prior.events.length, events: prior.events.map(event => ({...event, location: {...location, connected: false}}))}
          return {error}
        }
      }))
      const available = entries.filter(entry => entry && !entry.error)
      if (!available.length && entries.some(entry => entry?.error)) throw entries.find(entry => entry?.error).error
      // filterActivity only filters here; serverSort sets the order.
      const merged = serverSort(filterActivity(available.flatMap(entry => entry.events).map(activityRow), {...query, now, sort: {key: 'time'}}), query.sort).map(row => row.event)
      const total = available.reduce((sum, entry) => sum + entry.total, 0)
      return {events: exportAll ? merged : merged.slice(offset, offset + limit), total, now,
        snapshot: Object.fromEntries(available.map(entry => [entry.identity, entry.snapshot])),
        sandboxes: [...new Set(available.flatMap(entry => entry.sandboxes ?? []))], agents: [...new Set(available.flatMap(entry => entry.agents ?? []))],
        nextOffset: offset + limit < total ? offset + limit : null, unavailable: unavailable.filter(Boolean)}
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
      return {token, mode, count: entries.reduce((sum, entry) => sum + entry.plan.count, 0), expiresAt: entries.length ? Math.min(...entries.map(entry => entry.plan.expiresAt)) : Date.now(),
        sources: entries.map(entry => ({label: locationLabel(entry.location), count: entry.plan.count})), skipped: owners.filter(location => !location.connected).map(locationLabel)}
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
