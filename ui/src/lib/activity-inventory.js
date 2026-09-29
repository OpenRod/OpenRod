import { AGENTS } from './agents.js'

export const activityKey = (e) => e.id || `${e.sandbox}|${e.at}|${e.source}|${e.target}|${e.message}`
export const SEVERITY_RANK = { CRITICAL: 6, FATAL: 6, HIGH: 5, MED: 4, MEDIUM: 4, LOW: 3, INFO: 2, INFORMATIONAL: 2 }
const REASONS = { policy_dns_ineligible: 'no rule allows this host', transparent_tcp_policy_denied: 'no rule allows this connection' }
export const CATEGORY_NAMES = { NET: 'Network', HTTP: 'HTTP', SSH: 'Session', CONFIG: 'Configuration', PROC: 'Process', FILE: 'File', AUTH: 'Authentication', FINDING: 'Finding', EVENT: 'Event' }
export function activityRow(event) {
  const program = event.binary?.split('/').pop() || ''
  const known = AGENTS.find((a) => a.commands.includes(program.toLowerCase()) && program.toLowerCase() !== 'agent')
  const agent = known ? { name: known.name, logo: `/logos/agents/${known.logo}.svg` } : null
  const direction = event.direction || (event.kind === 'inbound' && ['NET', 'HTTP', 'SSH'].includes(event.category) ? 'in' : event.kind === 'audit' && ['NET', 'HTTP'].includes(event.category) ? 'out' : 'unknown')
  const values = {
    time: event.at ?? '', sandbox: event.sandbox ?? '', scope: event.scope ?? '', sandboxId: event.sandboxId ?? event.original?.sandboxId ?? '', agent: agent?.name ?? 'Unknown',
    category: CATEGORY_NAMES[event.category] ?? (event.kind === 'log' ? 'Log' : 'Unclassified'),
    severity: event.severity || 'Not reported',
    logLevel: event.level && event.level !== 'OCSF' ? event.level : 'Not reported', direction,
    verdict: event.verdict || (['NET', 'HTTP', 'SSH', 'AUTH'].includes(event.category) ? 'not reported' : 'not applicable'),
    outcome: event.outcome ?? 'unknown', process: event.binary ?? '',
    action: [known ? '' : program, event.method || event.action].filter(Boolean).join(' · ') || 'Not reported',
    destination: event.destination ?? '', policy: event.policy ?? '',
    session: event.sessionId ?? '', correlation: event.correlationId ?? '',
    why: REASONS[event.reason] ?? event.reason ?? '',
  }
  return { event, agent, key: activityKey(event), values, timestamp: Date.parse(event.at), search: [...Object.values(values), event.message, event.detail, event.source, event.target, JSON.stringify(event.original?.fields ?? event.original?.metadata ?? {})].join(' ').toLowerCase() }
}
export function filterActivity(rows, { query = '', direction = 'all', sandboxes = [], verdicts = [], filters = {}, range = 'all', from = '', to = '', now = Date.now(), sort = { key: 'time', direction: 'desc' } } = {}) {
  const names = new Set(sandboxes)
  const q = query.trim().toLowerCase()
  const start = range === 'custom' ? (from ? Date.parse(from) : -Infinity) : range === 'all' ? -Infinity : now - Number(range) * 60000
  const end = range === 'custom' && to ? Date.parse(to) : Infinity
  return rows.filter((r) => {
    if (direction !== 'all' && r.values.direction !== direction) return false
    if (names.size && !names.has(r.values.sandbox)) return false
    if (verdicts.length && !verdicts.includes(r.values.verdict)) return false
    if (q && !r.search.includes(q)) return false
    if (range !== 'all' && (!Number.isFinite(r.timestamp) || r.timestamp < start || r.timestamp > end)) return false
    return Object.entries(filters).every(([key, f]) => !f?.value?.trim() || ((f.mode === 'equals' ? (r.values[key] ?? '').toLowerCase() === f.value.trim().toLowerCase() : (r.values[key] ?? '').toLowerCase().includes(f.value.trim().toLowerCase())) !== (f.mode === 'excludes')))
  }).sort((a, b) => {
    const av = sort.key === 'severity' ? (SEVERITY_RANK[a.values.severity.toUpperCase()] ?? -1) : sort.key === 'time' ? (Number.isFinite(a.timestamp) ? a.timestamp : 0) : a.values[sort.key] ?? ''
    const bv = sort.key === 'severity' ? (SEVERITY_RANK[b.values.severity.toUpperCase()] ?? -1) : sort.key === 'time' ? (Number.isFinite(b.timestamp) ? b.timestamp : 0) : b.values[sort.key] ?? ''
    const order = typeof av === 'number' ? av - bv : av.localeCompare(bv, undefined, { numeric: true })
    return (sort.direction === 'asc' ? order : -order) || a.key.localeCompare(b.key)
  })
}
