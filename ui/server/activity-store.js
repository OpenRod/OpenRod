import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { logView } from './gateway.js'
import { activityRow, SEVERITY_RANK } from '../src/lib/activity-inventory.js'

const FIELDS = new Set(['time', 'sandbox', 'scope', 'sandboxId', 'agent', 'category', 'severity', 'logLevel', 'direction', 'verdict', 'outcome', 'process', 'action', 'destination', 'policy', 'session', 'correlation', 'why'])
export function createActivityStore(filename) {
  if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(filename)
  if (filename !== ':memory:') fs.chmodSync(filename, 0o600)
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
    CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, at INTEGER, received TEXT NOT NULL, sandbox TEXT NOT NULL, data TEXT NOT NULL, fields TEXT NOT NULL, search TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS events_time ON events(at, seq);
    CREATE INDEX IF NOT EXISTS events_sandbox ON events(sandbox, at);
    CREATE TABLE IF NOT EXISTS cursor_aliases (cursor TEXT PRIMARY KEY, event_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS deleted_events (id TEXT PRIMARY KEY, had_cursor INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`)
  db.prepare("INSERT OR IGNORE INTO meta VALUES ('startedAt', ?)").run(new Date().toISOString())
  // Rebuild only normalized fields when the parser changes; original envelopes stay intact.
  if (db.prepare("SELECT value FROM meta WHERE key='normalizer'").get()?.value !== '6') {
    const update = db.prepare('UPDATE events SET data=?, fields=?, search=? WHERE id=?')
    db.exec('BEGIN')
    try {
      for (const item of db.prepare('SELECT id, data FROM events').all()) {
        const old = JSON.parse(item.data)
        const parsed = old.original?.level ? logView(old.sandbox, old.original) : old
        const event = { ...old, ...parsed, id: old.id, scope: old.scope, receivedAt: old.receivedAt }
        const row = activityRow(event)
        update.run(JSON.stringify(event), JSON.stringify(row.values), row.search, item.id)
      }
      db.prepare("INSERT INTO meta VALUES ('normalizer', '6') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run()
      db.exec('COMMIT')
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  const plans = new Map()
  const head = () => Number(db.prepare("SELECT coalesce((SELECT seq FROM sqlite_sequence WHERE name='events'), 0) AS n").get().n)
  const insert = db.prepare('INSERT OR IGNORE INTO events(id, at, received, sandbox, data, fields, search) VALUES (?, ?, ?, ?, ?, ?, ?)')
  function ingest(event, scope = '') {
    const receivedAt = new Date().toISOString()
    let id = createHash('sha256').update(JSON.stringify([scope, event.id || event.original || event])).digest('hex')
    const cursorKey = event.sourceCursor ? createHash('sha256').update(JSON.stringify([scope, 'cursor', event.sourceCursor])).digest('hex') : null
    if (cursorKey) {
      if (db.prepare('SELECT event_id FROM cursor_aliases WHERE cursor=?').get(cursorKey)) return null
      const removed = db.prepare('SELECT had_cursor FROM deleted_events WHERE id=?').get(id)
      if (removed) {
        if (!removed.had_cursor) {
          db.prepare('UPDATE deleted_events SET had_cursor=1 WHERE id=?').run(id)
          db.prepare('INSERT OR IGNORE INTO cursor_aliases VALUES (?, ?)').run(cursorKey, id)
          return null
        }
        id = cursorKey
      }
      const existing = db.prepare('SELECT data FROM events WHERE id=?').get(id)
      if (existing) {
        const old = JSON.parse(existing.data)
        if (!old.sourceCursor) {
          db.prepare('UPDATE events SET data=? WHERE id=?').run(JSON.stringify({ ...old, sourceCursor: event.sourceCursor }), id)
          db.prepare('INSERT INTO cursor_aliases VALUES (?, ?)').run(cursorKey, id)
          return null
        }
        id = cursorKey // Distinct source positions must not collapse identical log envelopes.
      }
    }
    if (db.prepare('SELECT 1 FROM deleted_events WHERE id=?').get(id)) return null
    const saved = { ...event, id, scope, receivedAt }
    const row = activityRow(saved)
    const result = insert.run(id, Number.isFinite(row.timestamp) ? row.timestamp : null, receivedAt, saved.sandbox, JSON.stringify(saved), JSON.stringify(row.values), row.search)
    if (cursorKey) db.prepare('INSERT OR IGNORE INTO cursor_aliases VALUES (?, ?)').run(cursorKey, id)
    return result.changes ? saved : null
  }
  function source(id, patch) {
    const old = db.prepare('SELECT data FROM sources WHERE id = ?').get(id)
    const value = { ...(old ? JSON.parse(old.data) : {}), ...patch, id }
    db.prepare('INSERT INTO sources VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(id, JSON.stringify(value))
    return value
  }
  function coverage() {
    const counts = db.prepare('SELECT count(*) AS retained, min(at) AS oldest, max(at) AS newest FROM events').get()
    return { ...counts, deletionRevision: Number(db.prepare("SELECT value FROM meta WHERE key='deletionRevision'").get()?.value || 0), startedAt: db.prepare("SELECT value FROM meta WHERE key='startedAt'").get().value, sources: db.prepare('SELECT data FROM sources ORDER BY id').all().map((r) => JSON.parse(r.data)), complete: false, retention: 'Local archive; collected while the console server runs. No automatic expiry. Reconnects resume from a saved cursor when available; fallback replay is limited to 400 logs and 400 platform events per sandbox.' }
  }
  function selection(options = {}) {
    const bad = () => { throw Object.assign(new Error('Invalid activity query'), { status: 400 }) }
    if (!options || typeof options !== 'object' || Array.isArray(options)) bad()
    for (const key of ['query', 'direction', 'range', 'from', 'to']) if (options[key] !== undefined && typeof options[key] !== 'string') bad()
    for (const key of ['sandboxes', 'verdicts']) if (options[key] !== undefined && (!Array.isArray(options[key]) || options[key].length > 10000 || options[key].some((v) => typeof v !== 'string'))) bad()
    if (options.filters !== undefined && (!options.filters || typeof options.filters !== 'object' || Array.isArray(options.filters))) bad()
    for (const f of Object.values(options.filters ?? {})) if (!f || typeof f.value !== 'string' || !['equals', 'contains', 'excludes'].includes(f.mode)) bad()
    if (options.range === 'custom' && ((!options.from && !options.to) || (options.from && !Number.isFinite(Date.parse(options.from))) || (options.to && !Number.isFinite(Date.parse(options.to))) || (options.from && options.to && Date.parse(options.from) > Date.parse(options.to)))) bad()
    if (options.range && !['all', 'custom', '15', '60', '1440'].includes(options.range)) bad()
    for (const key of ['limit', 'offset', 'snapshot', 'now']) if (options[key] !== undefined && !Number.isSafeInteger(options[key])) bad()
    const now = Number.isFinite(options.now) ? options.now : Date.now()
    const snapshot = Number.isSafeInteger(options.snapshot) && options.snapshot >= 0 ? options.snapshot : head()
    const clauses = ['seq <= ?'], args = [snapshot]
    const field = (name) => `json_extract(fields, '$.${name}')`
    if (options.query?.trim()) { clauses.push('instr(search, ?) > 0'); args.push(options.query.trim().toLowerCase()) }
    for (const [name, values] of [['sandbox', options.sandboxes], ['verdict', options.verdicts]]) {
      if (Array.isArray(values) && values.length) { clauses.push(`${field(name)} IN (${values.map(() => '?').join(',')})`); args.push(...values) }
    }
    if (options.direction && options.direction !== 'all') { clauses.push(`${field('direction')} = ?`); args.push(options.direction) }
    const start = options.range === 'custom' ? Date.parse(options.from) : options.range && options.range !== 'all' ? now - Number(options.range) * 60000 : NaN
    const end = options.range === 'custom' ? Date.parse(options.to) : NaN
    if (Number.isFinite(start)) { clauses.push('at >= ?'); args.push(start) }
    if (Number.isFinite(end)) { clauses.push('at <= ?'); args.push(end) }
    for (const [key, f] of Object.entries(options.filters ?? {})) {
      if (!FIELDS.has(key) || !f?.value?.trim()) continue
      clauses.push(f.mode === 'equals' ? `lower(${field(key)}) = ?` : `instr(lower(${field(key)}), ?) ${f.mode === 'excludes' ? '=' : '>'} 0`)
      args.push(f.value.trim().toLowerCase())
    }
    return { where: clauses.join(' AND '), args, snapshot, now }
  }
  function query(options = {}) {
    const { where, args, snapshot, now } = selection(options)
    const field = (name) => `json_extract(fields, '$.${name}')`
    const key = FIELDS.has(options.sort?.key) ? options.sort.key : 'time'
    const severityOrder = `CASE upper(${field('severity')}) ${Object.entries(SEVERITY_RANK).map(([name, rank]) => `WHEN '${name}' THEN ${rank}`).join(' ')} ELSE -1 END`
    const order = options.sort?.direction === 'asc' ? 'ASC' : 'DESC'
    const limit = Math.min(500, Math.max(1, Math.floor(Number(options.limit)) || 200))
    const offset = Math.max(0, Math.floor(Number(options.offset) || 0))
    const total = db.prepare(`SELECT count(*) AS n FROM events WHERE ${where}`).get(...args).n
    const events = db.prepare(`SELECT data FROM events WHERE ${where} ORDER BY ${key === 'time' ? 'coalesce(at, 0)' : key === 'severity' ? severityOrder : field(key)} ${order}, id ASC LIMIT ? OFFSET ?`).all(...args, limit, offset).map((r) => JSON.parse(r.data))
    return { events, total, snapshot, now, sandboxes: db.prepare('SELECT DISTINCT sandbox FROM events ORDER BY sandbox').all().map((r) => r.sandbox), nextOffset: offset + events.length < total ? offset + events.length : null, coverage: coverage() }
  }
  function previewDeletion(input) {
    const bad = () => { throw Object.assign(new Error('Choose selected logs, matching logs, or all logs'), { status: 400 }) }
    if (!input || !['selected', 'matching', 'all'].includes(input.mode)) bad()
    const options = input.mode === 'matching' ? input.query : {}
    if (input.mode === 'matching' && (!options || typeof options !== 'object' || Array.isArray(options))) bad()
    // The preview fixes both the ingestion snapshot and relative time range.
    const scope = selection({ ...options, snapshot: head(), now: Date.now() })
    if (input.mode === 'selected') {
      if (!Array.isArray(input.ids) || !input.ids.length || input.ids.length > 5000 || input.ids.some((id) => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))) bad()
      scope.where += ` AND id IN (SELECT value FROM json_each(?))`
      scope.args.push(JSON.stringify([...new Set(input.ids)]))
    }
    const count = Number(db.prepare(`SELECT count(*) AS n FROM events WHERE ${scope.where}`).get(...scope.args).n)
    for (const [key, plan] of plans) if (plan.expiresAt < Date.now()) plans.delete(key)
    if (plans.size >= 100) plans.delete(plans.keys().next().value)
    const token = randomUUID(), expiresAt = Date.now() + 5 * 60000
    plans.set(token, { ...scope, expiresAt })
    return { token, mode: input.mode, count, expiresAt, snapshot: scope.snapshot }
  }
  function deleteLogs(token) {
    const plan = typeof token === 'string' ? plans.get(token) : null
    if (!plan || plan.expiresAt < Date.now()) throw Object.assign(new Error('Deletion review expired. Review the logs again.'), { status: 409 })
    const { where, args } = plan
    db.exec('BEGIN IMMEDIATE')
    try {
      // Keep only opaque identities so upstream replay cannot resurrect deleted evidence.
      db.prepare(`INSERT OR IGNORE INTO deleted_events SELECT id, CASE WHEN json_extract(data, '$.sourceCursor') IS NOT NULL AND json_extract(data, '$.sourceCursor') != '' THEN 1 ELSE 0 END FROM events WHERE ${where}`).run(...args)
      const count = Number(db.prepare(`DELETE FROM events WHERE ${where}`).run(...args).changes)
      if (count) db.prepare("INSERT INTO meta VALUES ('deletionRevision', '1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1").run()
      db.exec('COMMIT')
      plans.delete(token)
      return { deleted: count, coverage: coverage() }
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  return { ingest, source, coverage, query, previewDeletion, deleteLogs,
    has: (id) => Boolean(db.prepare('SELECT 1 FROM events WHERE id=?').get(id)),
    countAfter: (seq) => Number(db.prepare('SELECT count(*) AS n FROM events WHERE seq > ?').get(seq).n),
    getSource: (id) => { const row = db.prepare('SELECT data FROM sources WHERE id=?').get(id); return row ? JSON.parse(row.data) : null },
    head,
    after: (seq, limit = 100) => db.prepare('SELECT seq, data FROM events WHERE seq > ? ORDER BY seq LIMIT ?').all(seq, limit).map((r) => ({ seq: Number(r.seq), event: JSON.parse(r.data) })),
    close: () => db.close() }
}
