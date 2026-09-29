import * as React from "react"
import { ArrowDown, ArrowUp, Check, Copy, Filter, Pause, Play, Search, X } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet"
import { useVirtualRows } from "@/hooks/use-virtual-rows"
import { useDemoFleet } from "@/hooks/use-demo-fleet"
import { useLive } from "@/lib/live"
import { activityKey, activityRow, filterActivity } from "@/lib/activity-inventory"

const COLUMNS = [{ id: 'time', label: 'Time', width: 160 }, { id: 'verdict', label: 'Verdict', width: 100 }, { id: 'sandbox', label: 'Sandbox', width: 180 }, { id: 'program', label: 'Program', width: 130 }, { id: 'destination', label: 'Destination', width: 250 }, { id: 'why', label: 'Why', width: 260 }]
const RANGE = { all: 'Available history', 15: 'Last 15 minutes', 60: 'Last hour', 1440: 'Last 24 hours', custom: 'Custom range' }
const control = 'h-8 rounded-md border border-border bg-card px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring'
const timestamp = (at) => Number.isFinite(Date.parse(at)) ? new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—'

function Choices({ options, selected, onChange, label }) {
  const [query, setQuery] = React.useState('')
  const deferred = React.useDeferredValue(query)
  const matches = React.useMemo(() => options.filter((v) => v.toLowerCase().includes(deferred.toLowerCase())), [options, deferred])
  const virtual = useVirtualRows({ count: matches.length, rowHeight: 32 })
  React.useEffect(() => { virtual.scrollToTop() }, [deferred])
  const chosen = new Set(selected)
  return <>
    <Input aria-label={`Search ${label}`} placeholder={`Search ${label.toLowerCase()}…`} value={query} onChange={(e) => setQuery(e.target.value)} className="h-8 text-xs" />
    <div className="flex items-center justify-between text-[11px] text-muted-foreground"><span>{selected.length.toLocaleString()} selected · {matches.length.toLocaleString()} matches</span><button onClick={() => onChange([])} className="underline">Clear</button></div>
    <div ref={virtual.ref} onScroll={virtual.onScroll} className="h-56 overflow-auto" role="group" aria-label={label}>
      <div style={{ height: virtual.totalHeight, position: 'relative' }}><div style={{ transform: `translateY(${virtual.paddingTop}px)` }}>
        {matches.slice(virtual.start, virtual.end).map((value) => <label key={value} className="flex h-8 cursor-pointer items-center gap-2 rounded px-2 text-xs hover:bg-muted"><input type="checkbox" checked={chosen.has(value)} onChange={() => onChange(chosen.has(value) ? selected.filter((v) => v !== value) : [...selected, value])} /><span className="truncate" title={value}>{value}</span></label>)}
      </div></div>{!matches.length && <p className="py-5 text-center text-xs text-muted-foreground">No matches</p>}
    </div>
  </>
}

export function ActivityView() {
  const live = useDemoFleet(useLive())
  const [held, setHeld] = React.useState(null)
  const [anchor, setAnchor] = React.useState(Date.now)
  const [query, setQuery] = React.useState('')
  const [direction, setDirection] = React.useState('out')
  const [sandboxes, setSandboxes] = React.useState([])
  const [verdicts, setVerdicts] = React.useState([])
  const [filters, setFilters] = React.useState({})
  const [range, setRange] = React.useState('all')
  const [from, setFrom] = React.useState('')
  const [to, setTo] = React.useState('')
  const [sort, setSort] = React.useState({ key: 'time', direction: 'desc' })
  const [selected, setSelected] = React.useState(null)
  const events = held ?? live.events
  const hold = () => { if (!held) { setHeld(live.events); setAnchor(Date.now()) } }
  const change = (setter) => (value) => { hold(); setter(value) }
  React.useEffect(() => { if (!held) setAnchor(Date.now()) }, [live.events, held])
  const rows = React.useMemo(() => events.map(activityRow), [events])
  const options = React.useMemo(() => [...new Set([...(live.sandboxes ?? []).map((s) => s.name), ...events.map((e) => e.sandbox), ...sandboxes].filter(Boolean))].sort(), [live.sandboxes, events, sandboxes])
  const deferredQuery = React.useDeferredValue(query)
  const invalidRange = range === 'custom' && ((!from && !to) || (from && to && Date.parse(from) > Date.parse(to)))
  const shown = React.useMemo(() => invalidRange ? [] : filterActivity(rows, { query: deferredQuery, direction, sandboxes, verdicts, filters, range, from, to, now: anchor, sort }), [rows, deferredQuery, direction, sandboxes, verdicts, filters, range, from, to, anchor, sort, invalidRange])
  const virtual = useVirtualRows({ count: shown.length, rowHeight: 36 })
  React.useEffect(() => { virtual.scrollToTop() }, [deferredQuery, direction, sandboxes, verdicts, filters, range, from, to, sort])
  const pending = React.useMemo(() => {
    if (!held) return 0
    const known = new Set(held.map(activityKey))
    return live.events.filter((e) => !known.has(activityKey(e))).length
  }, [held, live.events])
  const denied = shown.filter((r) => r.values.verdict === 'denied').length
  const allowed = shown.filter((r) => r.values.verdict === 'allowed').length
  const times = rows.map((r) => r.timestamp).filter(Number.isFinite)
  const filtering = query || sandboxes.length || verdicts.length || range !== 'all' || Object.values(filters).some((f) => f.value)
  function clear() { hold(); setQuery(''); setSandboxes([]); setVerdicts([]); setFilters({}); setRange('all'); setFrom(''); setTo('') }
  const chips = [
    ...(query ? [{ label: `Search: ${query}`, clear: () => setQuery('') }] : []),
    ...(sandboxes.length ? [{ label: `${sandboxes.length} sandbox${sandboxes.length === 1 ? `: ${sandboxes[0]}` : 'es'}`, clear: () => setSandboxes([]) }] : []),
    ...(verdicts.length ? [{ label: `Verdict: ${verdicts.join(', ')}`, clear: () => setVerdicts([]) }] : []),
    ...(range !== 'all' ? [{ label: RANGE[range], clear: () => setRange('all') }] : []),
    ...Object.entries(filters).filter(([, f]) => f.value).map(([key, f]) => ({ label: `${COLUMNS.find((c) => c.id === key).label} ${f.mode}: ${f.value}`, clear: () => setFilters((old) => ({ ...old, [key]: { ...f, value: '' } })) })),
  ]
  const status = live.demo ? 'Demo stream' : ({ live: 'Live', connecting: 'Connecting', reconnecting: 'Reconnecting', 'gateway-down': 'Gateway unavailable' }[live.connection] ?? 'Disconnected')
  return <>
    <div className="flex h-[calc(100svh-3.5rem)] min-h-0 flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3 sm:px-6">
        <div className="relative mr-auto w-full sm:w-64"><Search className="absolute left-3 top-2.5 size-3.5 text-muted-foreground" /><Input aria-label="Search activity" placeholder="Search activity…" value={query} onChange={(e) => change(setQuery)(e.target.value)} className="h-9 pl-9 text-xs" /></div>
        <select aria-label="Direction" className={control} value={direction} onChange={(e) => change(setDirection)(e.target.value)}><option value="out">Outbound</option><option value="in">Inbound</option></select>
        <Popover><PopoverTrigger className={control}>Sandboxes{sandboxes.length ? ` · ${sandboxes.length}` : ''}</PopoverTrigger><PopoverContent align="end"><Choices label="Sandboxes" options={options} selected={sandboxes} onChange={change(setSandboxes)} /></PopoverContent></Popover>
        <select aria-label="Time range" className={control} value={range} onChange={(e) => change(setRange)(e.target.value)}>{Object.entries(RANGE).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>
        <Button size="sm" variant="outline" onClick={() => { if (held) { setHeld(null); setAnchor(Date.now()); virtual.scrollToTop() } else hold() }}>{held ? <Play /> : <Pause />}{held ? 'Resume' : 'Pause'}</Button>
      </div>
      {range === 'custom' && <div className="flex flex-wrap items-center gap-3 border-b border-border px-6 py-2 text-xs"><label className="flex items-center gap-2">From<input type="datetime-local" aria-label="From time" className={control} value={from} onInput={(e) => change(setFrom)(e.currentTarget.value)} /></label><label className="flex items-center gap-2">To<input type="datetime-local" aria-label="To time" className={control} value={to} onInput={(e) => change(setTo)(e.currentTarget.value)} /></label><span className="text-muted-foreground">{Intl.DateTimeFormat().resolvedOptions().timeZone}</span>{invalidRange && <span role="alert" className="text-red-600">Choose a start or end time; the end must follow the start.</span>}</div>}
      {Boolean(filtering) && <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-6 py-2">{chips.map((chip) => <button key={chip.label} onClick={chip.clear} title={`Remove ${chip.label}`} className="flex max-w-72 items-center gap-2 rounded border border-border bg-muted/40 px-2 py-1 text-[11px]"><span className="truncate">{chip.label}</span><X className="size-3 shrink-0" /></button>)}<Button size="xs" variant="ghost" onClick={clear}>Clear all</Button></div>}
      <div className="flex min-h-10 flex-wrap items-center gap-x-5 gap-y-1 border-b border-border px-6 py-2 text-[11px] text-muted-foreground"><span><strong className="font-mono text-foreground">{shown.length.toLocaleString()}</strong> matching events</span><span>{allowed.toLocaleString()} allowed</span><span className={denied ? 'text-red-600' : ''}>{denied.toLocaleString()} denied</span><span className="ml-auto">{Intl.DateTimeFormat().resolvedOptions().timeZone}</span></div>
      {held && <div className="flex min-h-10 items-center justify-between gap-3 border-b border-border bg-muted/40 px-6 py-1.5 text-xs"><span className="text-muted-foreground">Updates held · rows stay in place</span><Button size="xs" variant="outline" disabled={!pending} onClick={() => { setHeld(live.events); setAnchor(Date.now()); virtual.scrollToTop() }}>{pending.toLocaleString()} new available events</Button></div>}
      <div ref={virtual.ref} onScroll={(e) => { virtual.onScroll(e); if (e.currentTarget.scrollTop > 0) hold() }} tabIndex={0} role="region" aria-label="Activity events" className="min-h-0 flex-1 overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
        <table className="w-full min-w-[1080px] table-fixed border-separate border-spacing-0 text-xs" aria-label="Activity" aria-rowcount={shown.length + 1}>
          <colgroup>{COLUMNS.map((c) => <col key={c.id} style={{ width: c.width }} />)}</colgroup>
          <thead className="sticky top-0 z-10 bg-muted"><tr>{COLUMNS.map((c) => <th key={c.id} scope="col" aria-sort={sort.key === c.id ? sort.direction === 'asc' ? 'ascending' : 'descending' : 'none'} className="h-10 border-b border-border px-3 text-left font-medium text-muted-foreground"><div className="flex items-center gap-1"><button className="flex h-9 flex-1 items-center gap-1 outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => change(setSort)({ key: c.id, direction: sort.key === c.id && sort.direction === 'asc' ? 'desc' : 'asc' })}>{c.label}{sort.key === c.id && (sort.direction === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}</button>
            <Popover><PopoverTrigger aria-label={`Filter ${c.label}`} className={`rounded p-1 hover:bg-accent ${(c.id === 'time' ? range !== 'all' : c.id === 'sandbox' ? sandboxes.length : c.id === 'verdict' ? verdicts.length : filters[c.id]?.value) ? 'bg-accent text-foreground' : ''}`}><Filter className="size-3" /></PopoverTrigger><PopoverContent align="start">
              <p className="text-xs font-medium">Filter {c.label.toLowerCase()}</p>
              {c.id === 'sandbox' ? <Choices label="Sandboxes" options={options} selected={sandboxes} onChange={change(setSandboxes)} /> : c.id === 'verdict' ? <Choices label="Verdicts" options={['allowed', 'denied']} selected={verdicts} onChange={change(setVerdicts)} /> : c.id === 'time' ? <><select aria-label="Filter time" className={control} value={range} onChange={(e) => change(setRange)(e.target.value)}>{Object.entries(RANGE).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select><p className="text-[11px] text-muted-foreground">Custom dates appear above the table.</p></> : <>
                <select aria-label={`${c.label} match mode`} className={control} value={filters[c.id]?.mode ?? 'contains'} onChange={(e) => change(setFilters)({ ...filters, [c.id]: { value: filters[c.id]?.value ?? '', mode: e.target.value } })}><option value="contains">Contains</option><option value="excludes">Excludes</option></select>
                <Input aria-label={`${c.label} filter value`} placeholder={`Filter ${c.label.toLowerCase()}…`} value={filters[c.id]?.value ?? ''} onChange={(e) => change(setFilters)({ ...filters, [c.id]: { mode: filters[c.id]?.mode ?? 'contains', value: e.target.value } })} className="h-8 text-xs" />
              </>}
            </PopoverContent></Popover>
          </div></th>)}</tr></thead>
          <tbody>
            {virtual.paddingTop > 0 && <tr aria-hidden="true"><td colSpan={6} style={{ height: virtual.paddingTop, padding: 0 }} /></tr>}
            {shown.slice(virtual.start, virtual.end).map((row, i) => <tr key={row.key} aria-rowindex={virtual.start + i + 2} onClick={() => { hold(); setSelected(row) }} className={`group cursor-pointer hover:bg-muted/70 ${selected?.key === row.key ? 'bg-accent' : 'bg-card'}`}>
              {COLUMNS.map((c) => <td key={c.id} className={`h-9 border-b border-border/60 px-3 py-0 font-mono text-[11px] ${c.id === 'verdict' ? row.values.verdict === 'denied' ? 'text-red-600' : 'text-emerald-700' : c.id === 'destination' ? 'text-foreground' : 'text-muted-foreground'}`}>
                {c.id === 'time' ? <button aria-label={`Inspect event ${row.values.sandbox} ${row.values.time}`} aria-haspopup="dialog" className="h-8 w-full text-left outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={(e) => { e.stopPropagation(); hold(); setSelected(row) }}>{timestamp(row.values.time)}</button> : <span className="block truncate" title={row.values[c.id]}>{row.values[c.id] || '—'}</span>}
              </td>)}
            </tr>)}
            {virtual.end < shown.length && <tr aria-hidden="true"><td colSpan={6} style={{ height: (shown.length - virtual.end) * 36, padding: 0 }} /></tr>}
          </tbody>
        </table>
        {!shown.length && <div className="py-20 text-center text-sm text-muted-foreground"><p>{invalidRange ? 'Set a valid time range' : filtering ? 'No matching events in available history' : 'No activity available'}</p>{Boolean(filtering) && <Button variant="outline" size="sm" className="mt-3" onClick={clear}>Clear filters</Button>}</div>}
      </div>
      <footer className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-border bg-card px-6 py-2 text-[10px] text-muted-foreground"><span className="flex items-center gap-1.5"><span className={`size-1.5 rounded-full ${live.demo || live.connection === 'live' ? 'bg-emerald-500' : 'bg-amber-500'}`} />{status}{held ? ' · paused view' : ''}</span><span className="ml-auto">{events.length.toLocaleString()} loaded · latest 2,000 events maximum · partial history</span><span className="w-full">Available window: {times.length ? `${timestamp(new Date(Math.min(...times)).toISOString())} – ${timestamp(new Date(Math.max(...times)).toISOString())}` : 'No timestamps available'}</span></footer>
    </div>
    <Sheet open={Boolean(selected)} onOpenChange={(open) => { if (!open) setSelected(null) }}><SheetContent className="w-full gap-0 sm:max-w-lg"><SheetHeader className="border-b border-border pr-12"><SheetTitle>Event details</SheetTitle><SheetDescription>Full values from this event. The activity view stays paused.</SheetDescription></SheetHeader>{selected && <div className="min-h-0 flex-1 space-y-5 overflow-auto p-5">
      <dl className="space-y-4">{[['Timestamp', selected.values.time], ['Sandbox', selected.values.sandbox], ['Direction', selected.event.kind === 'inbound' ? 'Inbound' : 'Outbound'], ['Verdict', selected.values.verdict], ['Program', selected.event.binary ?? selected.values.program], ['Destination', selected.values.destination], ['Policy', selected.event.policy], ['Reason', selected.event.reason], ['Why', selected.values.why]].map(([label, value]) => <div key={label}><dt className="mb-1 text-[11px] text-muted-foreground">{label}</dt><dd className="flex items-start gap-2"><span className="min-w-0 flex-1 break-all font-mono text-xs">{value || '—'}</span>{value && <CopyButton label={label} value={value} />}</dd></div>)}</dl>
      <div><div className="mb-2 flex items-center justify-between"><h3 className="text-xs font-medium">Raw event</h3><CopyButton label="raw event" value={JSON.stringify(selected.event, null, 2)} /></div><pre className="overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-muted/40 p-3 text-[11px]">{JSON.stringify(selected.event, null, 2)}</pre></div>
    </div>}</SheetContent></Sheet>
  </>
}
function CopyButton({ label, value }) {
  const [copied, setCopied] = React.useState(false)
  React.useEffect(() => { if (copied) { const timer = setTimeout(() => setCopied(false), 1500); return () => clearTimeout(timer) } }, [copied])
  return <button className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted" aria-label={`Copy ${label}`} onClick={async () => { try { await navigator.clipboard.writeText(value); setCopied(true) } catch { toast.error('Could not copy to clipboard') } }}>{copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}</button>
}
