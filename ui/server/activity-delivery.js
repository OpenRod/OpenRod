import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { toOCSF } from '../src/lib/activity-export.js'

const fail = (message, status = 400) => Object.assign(new Error(message), { status })
const excluded = new BlockList()
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]]) excluded.addSubnet(address, prefix, 'ipv4')
const globalV6 = new BlockList(); globalV6.addSubnet('2000::', 3, 'ipv6')
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16]]) excluded.addSubnet(address, prefix, 'ipv6')
export function publicAddress(address) {
  const family = isIP(address)
  return family === 4 ? !excluded.check(address, 'ipv4') : family === 6 && globalV6.check(address, 'ipv6') && !excluded.check(address, 'ipv6')
}
export function destinationURL(value) {
  let url
  try { url = new URL(value) } catch { throw fail('Enter a valid HTTPS endpoint') }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || value.length > 2048) throw fail('Use HTTPS without embedded credentials, query parameters, or fragments')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || (isIP(host) && !publicAddress(host))) throw fail('Use a public HTTPS endpoint; private and local destinations are not supported')
  return url
}
// Resolve and pin the checked address for each attempt. No redirects, no proxy,
// default TLS certificate verification, and no remote response bodies in errors.
export async function postEvent(destination, event, signal) {
  const url = destinationURL(destination.url)
  const host = url.hostname.replace(/^\[|\]$/g, '')
  let addresses
  try { addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true }) } catch { throw fail('Endpoint DNS lookup failed', 502) }
  if (signal?.aborted) throw fail('Delivery stopped', 503)
  if (!addresses.length || addresses.some((entry) => !publicAddress(entry.address))) throw fail('Endpoint must resolve only to public addresses', 400)
  const payload = JSON.stringify(destination.format === 'ocsf' ? toOCSF(event) : event)
  if (Buffer.byteLength(payload) > 1024 * 1024) throw fail('Event exceeds the 1 MB delivery limit', 413)
  const headers = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'idempotency-key': event.id, 'user-agent': 'OpenShell-Activity/1.0' }
  if (destination.auth === 'bearer') headers.authorization = `Bearer ${destination.token}`
  if (destination.auth === 'api-key') headers['x-api-key'] = destination.token
  return new Promise((resolve, reject) => {
    const chosen = addresses[0]
    const req = https.request(url, { method: 'POST', headers, signal, agent: false,
      lookup: (_hostname, options, callback) => options.all ? callback(null, [chosen]) : callback(null, chosen.address, chosen.family),
    }, (res) => {
      const status = res.statusCode
      res.destroy()
      if (status >= 200 && status < 300) resolve({ status })
      else reject(fail(`Endpoint returned HTTP ${status}`, 502))
    })
    const timer = setTimeout(() => req.destroy(new Error('timeout')), 10000)
    req.on('close', () => clearTimeout(timer))
    req.on('error', () => reject(fail('HTTPS delivery failed or timed out', 502)))
    req.end(payload)
  })
}

export function createActivityDelivery(filename, store, { send = postEvent, now = Date.now } = {}) {
  if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(filename)
  if (filename !== ':memory:') fs.chmodSync(filename, 0o600)
  db.exec('PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS destinations (id TEXT PRIMARY KEY, data TEXT NOT NULL)')
  const active = new Map()
  let timer, stopped = false
  const all = () => db.prepare('SELECT data FROM destinations').all().map((r) => JSON.parse(r.data))
  const get = (id) => { const row = db.prepare('SELECT data FROM destinations WHERE id=?').get(id); if (!row) throw fail('Destination not found', 404); return JSON.parse(row.data) }
  const save = (d) => db.prepare('INSERT INTO destinations VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(d.id, JSON.stringify(d))
  const publicView = ({ token, ...d }) => ({ ...d, hasToken: Boolean(token), backlog: store.countAfter(d.cursor) })
  function create(input) {
    if (!input || typeof input !== 'object') throw fail('Invalid destination')
    if (all().length >= 20) throw fail('Maximum 20 destinations')
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80) throw fail('Enter a destination name (up to 80 characters)')
    if (typeof input.url !== 'string') throw fail('Enter an HTTPS endpoint')
    const url = destinationURL(input.url).toString()
    if (!['json', 'ocsf'].includes(input.format) || !['none', 'bearer', 'api-key'].includes(input.auth)) throw fail('Invalid format or authentication')
    if (input.auth !== 'none' && (typeof input.token !== 'string' || !input.token || input.token.length > 4096 || /[^\x20-\x7e]/.test(input.token))) throw fail('Enter a valid authentication token')
    const filters = input.filters || {}
    for (const key of ['sandboxes', 'categories', 'verdicts']) if (filters[key] !== undefined && (!Array.isArray(filters[key]) || filters[key].length > 100 || filters[key].some((v) => typeof v !== 'string' || !v || v.length > 128))) throw fail('Invalid event filters')
    const d = { id: randomUUID(), name: input.name.trim(), url, format: input.format, auth: input.auth, token: input.auth === 'none' ? '' : input.token,
      filters: { sandboxes: filters.sandboxes || [], categories: filters.categories || [], verdicts: filters.verdicts || [] },
      enabled: false, cursor: store.head(), createdAt: new Date(now()).toISOString(), attempts: 0, delivered: 0, skipped: 0, nextAttempt: 0, error: null, lastDeliveredAt: null, lastTest: null }
    save(d); return publicView(d)
  }
  async function run(d, test = false) {
    if (active.has(d.id)) throw fail('A delivery is already in progress', 409)
    const controller = new AbortController(); active.set(d.id, controller)
    try {
      if (test) {
        const at = new Date(now()).toISOString()
        const event = { id: randomUUID(), at, receivedAt: at, sandbox: 'synthetic-test', category: 'EVENT', action: 'DESTINATION_TEST', severity: 'INFO', message: 'Synthetic OpenShell destination test. No sandbox activity included.' }
        try {
          const result = await send(d, event, controller.signal)
          if (!stopped && !controller.signal.aborted) { const latest = get(d.id); latest.lastTest = { at, ok: true, status: result.status }; save(latest) }
          return { ok: true, status: result.status }
        } catch (error) {
          if (!stopped && !controller.signal.aborted) { const latest = get(d.id); latest.lastTest = { at, ok: false, error: error.message }; save(latest) }
          throw error
        }
      }
      for (const { seq, event } of store.after(d.cursor, 50)) {
        if (stopped || controller.signal.aborted) break
        if (!store.has(event.id)) continue
        const matches = [['sandboxes', event.sandbox], ['categories', event.category], ['verdicts', event.verdict]].every(([key, value]) => !d.filters[key].length || d.filters[key].includes(value))
        if (!matches) { d.cursor = seq; d.skipped++; save(d); continue }
        try {
          const result = await send(d, event, controller.signal)
          if (stopped || controller.signal.aborted) break
          d.cursor = seq; d.delivered++; d.attempts = 0; d.error = null; d.failedEventId = null; d.nextAttempt = 0; d.lastStatus = result.status; d.lastDeliveredAt = new Date(now()).toISOString(); save(d)
        } catch (error) {
          if (stopped || controller.signal.aborted) break
          d.attempts++; d.failedEventId = event.id; d.error = error.message; d.nextAttempt = now() + Math.min(300000, 1000 * 2 ** d.attempts)
          if (d.attempts >= 8) d.enabled = false
          save(d); break
        }
      }
    } finally { active.delete(d.id) }
  }
  async function tick() {
    if (stopped) return
    await Promise.all(all().filter((d) => d.enabled && d.nextAttempt <= now() && !active.has(d.id)).map((d) => run(d).catch(() => {})))
  }
  function change(id, action) {
    const d = get(id)
    active.get(id)?.abort()
    if (action === 'remove') { db.prepare('DELETE FROM destinations WHERE id=?').run(id); return { ok: true } }
    if (!['pause', 'resume', 'retry'].includes(action)) throw fail('Unknown destination action')
    d.enabled = action !== 'pause'
    if (d.enabled) { d.attempts = 0; d.nextAttempt = 0 }
    save(d); return publicView(d)
  }
  return {
    list: () => all().map(publicView), create, change, tick,
    logsDeleted() {
      for (const controller of active.values()) controller.abort()
      for (const d of all()) if (d.failedEventId && !store.has(d.failedEventId)) {
        d.failedEventId = null; d.error = null; d.attempts = 0; d.nextAttempt = 0; save(d)
      }
    },
    test: (id) => run(get(id), true),
    start() { timer = setInterval(() => { void tick() }, 2000); timer.unref(); void tick() },
    stop() { stopped = true; clearInterval(timer); for (const controller of active.values()) controller.abort(); db.close() },
  }
}
