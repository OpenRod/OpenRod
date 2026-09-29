import * as React from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api'

const fresh = () => ({ name: '', url: '', format: 'ocsf', auth: 'none', token: '', sandboxes: '', category: '', verdict: '' })
const select = 'h-9 w-full rounded-md border border-border bg-card px-2 text-xs'
const date = (value) => value ? new Date(value).toLocaleString() : 'Never'
export function ActivityDestinations() {
  const [items, setItems] = React.useState([])
  const [draft, setDraft] = React.useState(fresh)
  const [adding, setAdding] = React.useState(false)
  const [removing, setRemoving] = React.useState(null)
  const [busy, setBusy] = React.useState(null)
  const [error, setError] = React.useState(null)
  const [loaded, setLoaded] = React.useState(false)
  const refresh = React.useCallback(async () => {
    try { setItems(await api.activityDestinations()); setError(null); setLoaded(true) } catch (e) { setError(e.message) }
  }, [])
  React.useEffect(() => { refresh(); const timer = setInterval(refresh, 5000); return () => clearInterval(timer) }, [refresh])
  const field = (name) => ({ value: draft[name], onChange: (e) => setDraft((old) => ({ ...old, [name]: e.target.value })) })
  async function action(id, kind) {
    setBusy(id)
    try {
      const result = await api.activityDestinationAction(id, kind)
      if (kind === 'test') toast.success(`Test accepted · HTTP ${result.status}`)
      await refresh(); setRemoving(null)
    } catch (e) { toast.error(e.message); await refresh() } finally { setBusy(null) }
  }
  async function create(e) {
    e.preventDefault(); setBusy('new')
    try {
      await api.createActivityDestination({ name: draft.name, url: draft.url, format: draft.format, auth: draft.auth, token: draft.token,
        filters: { sandboxes: draft.sandboxes.split(',').map((s) => s.trim()).filter(Boolean), categories: draft.category ? [draft.category] : [], verdicts: draft.verdict ? [draft.verdict] : [] } })
      setDraft(fresh()); setAdding(false); await refresh(); toast.success('Webhook saved paused. Send a test, then enable forwarding.')
    } catch (e) { toast.error(e.message) } finally { setBusy(null) }
  }
  return <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
    <p className="text-xs leading-relaxed text-muted-foreground">One event per HTTPS POST, while the console server runs—even with this page closed. New webhooks start paused and collect from the point they are created. Enable forwarding to send matching records, including original log evidence, to the endpoint you configure.</p>
    {error && <div role="alert" className="rounded-md border border-destructive/30 p-3 text-xs">{error}<button className="ml-2 underline" onClick={refresh}>Retry</button></div>}
    {!loaded && !error && <p role="status" className="text-xs text-muted-foreground">Loading webhooks…</p>}
    {items.map((item) => <section key={item.id} className="space-y-3 rounded-lg border border-border p-4">
      <div className="flex items-center justify-between gap-3"><h3 className="truncate text-sm font-medium">{item.name}</h3><span className={`text-xs ${item.error ? 'text-amber-700' : 'text-muted-foreground'}`}>{item.enabled ? item.error ? 'Retrying' : 'Enabled' : item.error ? 'Needs attention' : 'Paused'}</span></div>
      <p className="break-all font-mono text-[11px] text-muted-foreground">{item.url}</p>
      <p className="text-xs text-muted-foreground">{item.format === 'ocsf' ? 'OCSF 1.4.0 · Base Event' : 'Console JSON'} · {item.auth === 'none' ? 'No authentication' : item.auth === 'bearer' ? 'Bearer token stored' : 'X-API-Key stored'}</p>
      <p className="text-xs">{item.filters.sandboxes.join(', ') || 'All sandboxes'} · {item.filters.categories.join(', ') || 'All event types'} · {item.filters.verdicts.join(', ') || 'All decisions'}</p>
      <dl className="grid grid-cols-3 gap-3 text-xs"><div><dt className="text-muted-foreground">Delivered</dt><dd className="mt-1">{item.delivered.toLocaleString()}</dd></div><div><dt className="text-muted-foreground">Awaiting scan / delivery</dt><dd className="mt-1">{item.backlog.toLocaleString()}</dd></div><div><dt className="text-muted-foreground">Filtered out</dt><dd className="mt-1">{item.skipped.toLocaleString()}</dd></div></dl>
      <p className="text-[11px] text-muted-foreground">Last delivery: {date(item.lastDeliveredAt)}{item.lastStatus ? ` · HTTP ${item.lastStatus}` : ''}</p>
      {item.lastTest && <p className="text-[11px] text-muted-foreground">Test: {item.lastTest.ok ? `Accepted · HTTP ${item.lastTest.status}` : item.lastTest.error} · {date(item.lastTest.at)}</p>}
      {item.error && <p role="status" className="text-xs text-amber-700">{item.error} · Attempt {item.attempts}/8{item.enabled ? ` · Next retry ${date(item.nextAttempt)}` : ' · Forwarding paused; queued events retained'}</p>}
      <div className="flex flex-wrap gap-2">
        <Button size="xs" variant="outline" disabled={Boolean(busy)} onClick={() => action(item.id, 'test')}>Send synthetic test</Button>
        <Button size="xs" variant="outline" disabled={Boolean(busy)} onClick={() => action(item.id, item.enabled ? 'pause' : 'resume')}>{item.enabled ? 'Pause' : 'Enable forwarding'}</Button>
        {item.error && <Button size="xs" variant="outline" disabled={Boolean(busy)} onClick={() => action(item.id, 'retry')}>Retry now</Button>}
        <Button size="xs" variant="ghost" disabled={Boolean(busy)} onClick={() => setRemoving(item.id)}>Remove</Button>
      </div>
      {removing === item.id && <div className="space-y-2 border-t border-border pt-3 text-xs"><p>Remove this webhook and its delivery position? Activity history will remain.</p><Button size="xs" variant="destructive" disabled={Boolean(busy)} onClick={() => action(item.id, 'remove')}>Remove webhook</Button><Button size="xs" variant="ghost" onClick={() => setRemoving(null)}>Cancel</Button></div>}
    </section>)}
    {loaded && !items.length && !adding && <div className="rounded-lg border border-dashed border-border p-6 text-center"><p className="text-sm">No webhooks connected</p><p className="mt-1 text-xs text-muted-foreground">Add a JSON ingestion endpoint from your SIEM or webhook receiver.</p></div>}
    {!adding ? <Button size="sm" variant="outline" onClick={() => setAdding(true)}>Add webhook</Button> : <form onSubmit={create} className="space-y-4 rounded-lg border border-border p-4">
      <h3 className="text-sm font-medium">New webhook</h3>
      <label className="block space-y-1 text-xs"><span>Name</span><Input required maxLength={80} placeholder="Security monitoring" {...field('name')} /></label>
      <label className="block space-y-1 text-xs"><span>HTTPS endpoint</span><Input required type="url" placeholder="https://logs.example.com/events" {...field('url')} /></label>
      <p className="text-[11px] text-muted-foreground">Public HTTPS endpoints only. The receiver must accept a single JSON event per POST and return HTTP 2xx. Vendor-specific envelopes such as Splunk HEC require a compatible adapter.</p>
      <div className="grid gap-3 sm:grid-cols-2"><label className="space-y-1 text-xs"><span>Event format</span><select className={select} {...field('format')}><option value="ocsf">OCSF JSON · Base Event</option><option value="json">Console JSON</option></select></label><label className="space-y-1 text-xs"><span>Authentication</span><select className={select} {...field('auth')}><option value="none">None</option><option value="bearer">Bearer token</option><option value="api-key">X-API-Key</option></select></label></div>
      {draft.auth !== 'none' && <label className="block space-y-1 text-xs"><span>{draft.auth === 'bearer' ? 'Bearer token' : 'API key'}</span><Input required type="password" autoComplete="new-password" {...field('token')} /><span className="block text-[11px] text-muted-foreground">Stored in a local file restricted to your OS account. Never returned to the browser.</span></label>}
      <label className="block space-y-1 text-xs"><span>Sandbox names (optional)</span><Input placeholder="All sandboxes, or comma-separated names" {...field('sandboxes')} /></label>
      <div className="grid gap-3 sm:grid-cols-2"><label className="space-y-1 text-xs"><span>Event type</span><select className={select} {...field('category')}><option value="">All event types</option>{Object.entries({ NET: 'Network', HTTP: 'HTTP', SSH: 'Session', AUTH: 'Authentication', PROC: 'Process', FILE: 'File', CONFIG: 'Configuration', FINDING: 'Finding', EVENT: 'Event' }).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label><label className="space-y-1 text-xs"><span>Decision</span><select className={select} {...field('verdict')}><option value="">All decisions</option><option value="allowed">Allowed</option><option value="denied">Denied</option></select></label></div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">OCSF uses the Base Event class, preserving source fields under unmapped.openshell. It does not infer specialized event classes or missing actor details.</p>
      <div className="flex gap-2"><Button type="submit" size="sm" disabled={Boolean(busy)}>Save paused</Button><Button type="button" size="sm" variant="ghost" onClick={() => { setAdding(false); setDraft(fresh()) }}>Cancel</Button></div>
    </form>}
    <p className="text-[11px] leading-relaxed text-muted-foreground">Delivery is at least once: receivers should deduplicate using the Idempotency-Key header or event ID. Failed events retry with backoff, then pause after 8 attempts. HTTP acceptance does not confirm indexing in your SIEM. Local history and delivery positions survive restarts; collection gaps still apply.</p>
  </div>
}
