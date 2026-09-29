import { AGENTS } from "./agents.js"

export const activityKey = (e) => `${e.sandbox}|${e.at}|${e.message}`
const REASONS = { policy_dns_ineligible: 'no rule allows this host', transparent_tcp_policy_denied: 'no rule allows this connection' }
export function activityRow(event) {
  const why = event.verdict === 'denied' ? REASONS[event.reason] ?? event.reason ?? '' : event.policy?.replace(/^_provider_/, 'provider · ') ?? ''
  const program = event.binary?.split('/').pop() || ''
  const known = AGENTS.find((agent) => agent.commands.includes(program.toLowerCase()) && program.toLowerCase() !== 'agent')
  const agent = known ? { name: known.name, logo: `/logos/agents/${known.logo}.svg` } : null
  const values = { time: event.at ?? '', verdict: event.verdict ?? '', sandbox: event.sandbox ?? '', agent: agent?.name ?? '', action: [known ? '' : program, event.method].filter(Boolean).join(' · '), destination: event.destination ?? event.detail ?? '', why }
  return { event, agent, key: activityKey(event), values, timestamp: Date.parse(event.at), search: [...Object.values(values), event.binary, event.reason, event.detail].join(' ').toLowerCase() }
}
export function filterActivity(rows, { query = '', direction = 'out', sandboxes = [], verdicts = [], filters = {}, range = 'all', from = '', to = '', now = Date.now(), sort = { key: 'time', direction: 'desc' } } = {}) {
  const names = new Set(sandboxes)
  const q = query.trim().toLowerCase()
  const start = range === 'custom' ? (from ? Date.parse(from) : -Infinity) : range === 'all' ? -Infinity : now - Number(range) * 60000
  const end = range === 'custom' && to ? Date.parse(to) : Infinity
  const matched = rows.filter((r) => {
    if (r.event.kind !== (direction === 'out' ? 'audit' : 'inbound') || !r.values.verdict) return false
    if (names.size && !names.has(r.values.sandbox)) return false
    if (verdicts.length && !verdicts.includes(r.values.verdict)) return false
    if (q && !r.search.includes(q)) return false
    if (range !== 'all' && (!Number.isFinite(r.timestamp) || r.timestamp < start || r.timestamp > end)) return false
    return Object.entries(filters).every(([key, f]) => !f?.value?.trim() || (r.values[key].toLowerCase().includes(f.value.trim().toLowerCase()) !== (f.mode === 'excludes')))
  })
  return matched.sort((a, b) => {
    const av = sort.key === 'time' ? (Number.isFinite(a.timestamp) ? a.timestamp : 0) : a.values[sort.key]
    const bv = sort.key === 'time' ? (Number.isFinite(b.timestamp) ? b.timestamp : 0) : b.values[sort.key]
    const order = typeof av === 'number' ? av - bv : av.localeCompare(bv, undefined, { numeric: true })
    return (sort.direction === 'asc' ? order : -order) || a.key.localeCompare(b.key)
  })
}
