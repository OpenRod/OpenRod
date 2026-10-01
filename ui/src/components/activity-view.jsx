import { SelectField } from "@/components/ui/select-field"
import * as React from "react"
import { ArrowDown, ArrowUp, Check, Copy, Filter, Pause, Play, X, SlidersHorizontal, Download, Webhook, ChevronDown, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { ActivityDestinations } from "@/components/activity-destinations"
import { useApi, useLocation } from "@/lib/location-context"
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from "@/components/ui/alert-dialog"
import { exportDocument } from "@/lib/activity-export"
import { AgentLabel } from "@/components/agent-label"
import { AGENTS } from "@/lib/agents"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { SearchInput } from "@/components/ui/search-input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet"
import { useVirtualRows } from "@/hooks/use-virtual-rows"
import { useDemoFleet } from "@/hooks/use-demo-fleet"
import { useActivityHistory } from "@/hooks/use-activity-history"
import { useLive } from "@/lib/live"
import { activityKey, activityRow, filterActivity } from "@/lib/activity-inventory"
import { Notice } from "@/components/notice"

const PAGE_SIZE = 50
const COLUMNS = [{ id: 'time', label: 'Time', width: 150 }, { id: 'severity', label: 'Security severity', width: 150 }, { id: 'logLevel', label: 'Log level', width: 110 }, { id: 'sandbox', label: 'Sandbox', width: 125 }, { id: 'agent', label: 'Observed agent', width: 145 }, { id: 'action', label: 'Activity', width: 200 }, { id: 'verdict', label: 'Decision', width: 125 }, { id: 'destination', label: 'Target', width: 260 }]
const AGENT_LABELS = Object.fromEntries(AGENTS.map((agent) => [agent.name, { name: agent.name, logo: `/logos/agents/${agent.logo}.svg` }]))
const RANGE = { all: 'Available history', 15: 'Last 15 minutes', 60: 'Last hour', 1440: 'Last 24 hours', custom: 'Custom range' }
const control = 'h-8 rounded-md border border-border bg-card px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring'
const timestamp = (at) => Number.isFinite(Date.parse(at)) ? new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '-'

function Choices({ options, selected, onChange, label }) {
  const [query, setQuery] = React.useState('')
  const deferred = React.useDeferredValue(query)
  const matches = React.useMemo(() => options.filter((v) => v.toLowerCase().includes(deferred.toLowerCase())), [options, deferred])
  const virtual = useVirtualRows({ count: matches.length, rowHeight: 32 })
  React.useEffect(() => { virtual.scrollToTop() }, [deferred])
  const chosen = new Set(selected)
  return <>
    <SearchInput aria-label={`Search ${label}`} placeholder={`Search ${label.toLowerCase()}…`} value={query} onValueChange={setQuery} />
    <div className="flex items-center justify-between text-[11px] text-muted-foreground"><span>{selected.length.toLocaleString()} selected · {matches.length.toLocaleString()} matches</span><button onClick={() => onChange([])} className="underline">Clear</button></div>
    <div ref={virtual.ref} onScroll={virtual.onScroll} className="h-56 overflow-auto" role="group" aria-label={label}>
      <div style={{ height: virtual.totalHeight, position: 'relative' }}><div style={{ transform: `translateY(${virtual.paddingTop}px)` }}>
        {matches.slice(virtual.start, virtual.end).map((value) => <label key={value} className="flex h-8 cursor-pointer items-center gap-2 rounded px-2 text-xs hover:bg-muted"><input type="checkbox" checked={chosen.has(value)} onChange={() => onChange(chosen.has(value) ? selected.filter((v) => v !== value) : [...selected, value])} /><span className="truncate" title={value}>{value}</span></label>)}
      </div></div>{!matches.length && <p className="py-5 text-center text-xs text-muted-foreground">No matches</p>}
    </div>
  </>
}

function localDate(value) { if (!value || !Number.isFinite(Date.parse(value))) return value || ''; const date = new Date(value); return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 19) }
function readInvestigation() {
  try {
    const value = JSON.parse(new URLSearchParams(window.location.search).get('investigation') || '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    const result = {}
    for (const key of ['query', 'direction', 'range', 'from', 'to']) if (typeof value[key] === 'string') result[key] = value[key]
    for (const key of ['sandboxes', 'verdicts', 'agents']) if (Array.isArray(value[key]) && value[key].every((v) => typeof v === 'string')) result[key] = value[key]
    if (value.filters && typeof value.filters === 'object' && Object.values(value.filters).every((f) => f && typeof f.value === 'string' && ['equals', 'contains', 'excludes'].includes(f.mode))) result.filters = value.filters
    if (value.sort && typeof value.sort.key === 'string' && ['asc', 'desc'].includes(value.sort.direction)) result.sort = value.sort
    return normalizeAgentSelection(result)
  } catch { return {} }
}
function normalizeAgentSelection(view) {
  if (view.filters?.agent?.mode !== 'equals') return view
  const { agent, ...filters } = view.filters
  return { ...view, agents: view.agents ?? (agent.value ? [agent.value] : []), filters }
}
function readSaved() { try { const views = JSON.parse(localStorage.getItem('openshell.activity.views') || '[]'); return Array.isArray(views) ? views.filter((v) => v && typeof v.name === 'string' && v.query && typeof v.query === 'object') : [] } catch { return [] } }
function download(events, context, format) {
  const blob = new Blob([JSON.stringify(exportDocument(events, context, format), null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob), link = document.createElement('a')
  link.href = url; link.download = format === 'ocsf' ? 'openshell-activity-ocsf.json' : 'openshell-activity.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function ActivityView() {
  const location = useLocation()
  return <ScopedActivityView key={location?.id ?? location?.context ?? "default"} />
}

function ScopedActivityView() {
  const api = useApi()
  const location = useLocation()
  const live = useDemoFleet(useLive())
  const [initial] = React.useState(readInvestigation)
  const [visibleColumns, setVisibleColumns] = React.useState(['time', 'sandbox', 'agent', 'action', 'verdict', 'destination'])
  const columns = COLUMNS.filter((c) => visibleColumns.includes(c.id))
  const [saved, setSaved] = React.useState(readSaved)
  const [viewName, setViewName] = React.useState('')
  const [destinationsOpen, setDestinationsOpen] = React.useState(false)
  const [viewPanel, setViewPanel] = React.useState('columns')
  const [exportOptions, setExportOptions] = React.useState(null)
  const [exporting, setExporting] = React.useState(false)
  const [held, setHeld] = React.useState(null)
  const [anchor, setAnchor] = React.useState(Date.now)
  const [query, setQuery] = React.useState(initial.query ?? '')
  const [direction, setDirection] = React.useState(initial.direction ?? "all")
  const [sandboxes, setSandboxes] = React.useState(initial.sandboxes ?? [])
  const [agents, setAgents] = React.useState(initial.agents ?? [])
  const [verdicts, setVerdicts] = React.useState(initial.verdicts ?? [])
  const [filters, setFilters] = React.useState(initial.filters ?? {})
  const [range, setRange] = React.useState(initial.range ?? 'all')
  const [from, setFrom] = React.useState(localDate(initial.from))
  const [to, setTo] = React.useState(localDate(initial.to))
  const [sort, setSort] = React.useState(initial.sort ?? { key: 'time', direction: 'desc' })
  const [selected, setSelected] = React.useState(null)
  const [checked, setChecked] = React.useState(() => new Set())
  const [deletion, setDeletion] = React.useState(null)
  const [deleteBusy, setDeleteBusy] = React.useState(false)
  const [deleteError, setDeleteError] = React.useState(null)
  const deferredQuery = React.useDeferredValue(query)
  const investigation = { query: deferredQuery, direction, sandboxes, verdicts, agents, filters, range, from: from && Number.isFinite(Date.parse(from)) ? new Date(from).toISOString() : from, to: to && Number.isFinite(Date.parse(to)) ? new Date(to).toISOString() : to, sort }
  const pageQuery = JSON.stringify(investigation)
  const [demoPagination, setDemoPagination] = React.useState({ query: pageQuery, page: 0 })
  const history = useActivityHistory({ ...investigation, limit: PAGE_SIZE }, { paused: Boolean(held), demo: live.demo, activityRevision: live.activityRevision })
  React.useEffect(() => { setChecked(new Set()); setSelected(null) }, [live.activityRevision])
  React.useEffect(() => { setChecked(new Set()) }, [deferredQuery, direction, sandboxes, verdicts, agents, filters, range, from, to])
  async function reviewDeletion(mode, ids) {
    hold(); setDeleteBusy(true); setDeleteError(null)
    try {
      const plan = await api.previewActivityDeletion({ mode, ids: ids || [...checked], query: investigation })
      setDeletion(plan)
    } catch (e) { toast.error(e.message) } finally { setDeleteBusy(false) }
  }
  async function confirmDeletion() {
    setDeleteBusy(true); setDeleteError(null)
    try {
      const result = await api.deleteActivity(deletion.token)
      setDeletion(null); setSelected(null); setChecked(new Set()); setHeld([])
      history.refresh(); live.refresh()
      toast.success(`Deleted ${result.deleted.toLocaleString()} log${result.deleted === 1 ? '' : 's'}`)
    } catch (e) { setDeleteError(e.message) } finally { setDeleteBusy(false) }
  }
  function toggleChecked(id) {
    hold()
    setChecked((old) => { const next = new Set(old); if (next.has(id)) next.delete(id); else if (next.size < 5000) next.add(id); return next })
  }
  const events = live.demo ? held ?? live.events : history.events
  function applyView(view) {
    view = normalizeAgentSelection(view)
    hold(); setQuery(view.query || ''); setDirection(view.direction || 'all'); setSandboxes(view.sandboxes || []); setVerdicts(view.verdicts || []); setAgents(view.agents || []); setFilters(view.filters || {}); setRange(view.range || 'all'); setFrom(localDate(view.from)); setTo(localDate(view.to)); setSort(view.sort || { key: 'time', direction: 'desc' })
  }
  function pivot(key, value) {
    applyView({ filters: { [key]: { mode: 'equals', value } } }); setSelected(null)
  }
  function openExport(format) {
    setExportOptions({ format, columns: [...visibleColumns], range, from, to })
  }
  const exportInvalid = exportOptions && (!exportOptions.columns.length || (exportOptions.range === 'custom' && ((!exportOptions.from && !exportOptions.to) || (exportOptions.from && !Number.isFinite(Date.parse(exportOptions.from))) || (exportOptions.to && !Number.isFinite(Date.parse(exportOptions.to))) || (exportOptions.from && exportOptions.to && Date.parse(exportOptions.from) > Date.parse(exportOptions.to)))))
  async function exportMatches() {
    if (!exportOptions || exportInvalid) return
    const { format: exportFormat, columns, range, from, to } = exportOptions
    const exportQuery = { ...investigation, columns, range, from: from ? new Date(from).toISOString() : '', to: to ? new Date(to).toISOString() : '' }
    setExporting(true)
    try {
      if (live.demo) { download(filterActivity(rows, { ...exportQuery, now: anchor }).map((r) => r.event), { ...exportQuery, demo: true }, exportFormat); setExportOptions(null); return }
      const link = document.createElement('a')
      link.href = api.url("/activity/export", { format: exportFormat, query: JSON.stringify(exportQuery), context: await api.contextKey(), ...(location ? { location: "1" } : {}) })
      link.download = exportFormat === 'ocsf' ? 'openshell-activity-ocsf.json' : 'openshell-activity.json'
      document.body.appendChild(link); link.click(); link.remove(); setExportOptions(null)
    } catch (e) { toast.error(`Export failed: ${e.message}`) } finally { setExporting(false) }
  }
  const hold = () => { if (!held) { setHeld(events); setAnchor(Date.now()) } }
  const change = (setter) => (value) => { hold(); setter(value) }
  const rows = React.useMemo(() => events.map(activityRow), [events])
  const options = React.useMemo(() => [...new Set([...(live.sandboxes ?? []).map((s) => s.name), ...(history.sandboxes ?? []), ...events.map((e) => e.sandbox), ...sandboxes].filter(Boolean))].sort(), [live.sandboxes, history.sandboxes, events, sandboxes])
  const agentOptions = React.useMemo(() => [...new Set(live.demo ? rows.map((row) => row.values.agent) : history.agents ?? rows.map((row) => row.values.agent))].filter(Boolean).sort((a, b) => a.localeCompare(b)), [live.demo, rows, history.agents])
  const invalidRange = range === 'custom' && ((!from && !to) || (from && to && Date.parse(from) > Date.parse(to)))
  const matchingRows = React.useMemo(() => invalidRange ? [] : !live.demo ? rows : filterActivity(rows, { query: deferredQuery, direction, sandboxes, verdicts, agents, filters, range, from, to, now: anchor, sort }), [rows, deferredQuery, direction, sandboxes, verdicts, agents, filters, range, from, to, anchor, sort, invalidRange, live.demo])
  const total = invalidRange ? 0 : live.demo ? matchingRows.length : history.total || 0
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const page = live.demo ? Math.min(demoPagination.query === pageQuery ? demoPagination.page : 0, pageCount - 1) : history.page
  const shown = live.demo ? matchingRows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE) : matchingRows
  function navigatePage(nextPage) {
    hold(); setChecked(new Set()); setSelected(null)
    if (live.demo) setDemoPagination({ query: pageQuery, page: nextPage })
    else history.goToPage(nextPage)
  }
  const virtual = useVirtualRows({ count: shown.length, rowHeight: 48 })
  React.useEffect(() => { virtual.scrollToTop() }, [deferredQuery, direction, sandboxes, verdicts, agents, filters, range, from, to, sort, page])
  const pending = React.useMemo(() => {
    if (!held) return 0
    const known = new Set(held.map(activityKey))
    return live.events.filter((e) => !known.has(activityKey(e))).length
  }, [held, live.events])
  const denied = shown.filter((r) => r.values.verdict === 'denied').length
  const allowed = shown.filter((r) => r.values.verdict === 'allowed').length
  const filtering = query || sandboxes.length || verdicts.length || agents.length || direction !== 'all' || range !== 'all' || Object.values(filters).some((f) => f.value)
  function clear() { hold(); setQuery(''); setDirection('all'); setSandboxes([]); setVerdicts([]); setAgents([]); setFilters({}); setRange('all'); setFrom(''); setTo('') }
  const chips = [
    ...(direction !== 'all' ? [{ label: `Direction: ${direction}`, clear: () => setDirection('all') }] : []),
    ...(query ? [{ label: `Search: ${query}`, clear: () => setQuery('') }] : []),
    ...(sandboxes.length ? [{ label: `${sandboxes.length} sandbox${sandboxes.length === 1 ? `: ${sandboxes[0]}` : 'es'}`, clear: () => setSandboxes([]) }] : []),
    ...(agents.length ? [{ label: `Observed agents: ${agents.join(', ')}`, clear: () => setAgents([]) }] : []),
    ...(verdicts.length ? [{ label: `Decision: ${verdicts.join(', ')}`, clear: () => setVerdicts([]) }] : []),
    ...(range !== 'all' ? [{ label: RANGE[range], clear: () => setRange('all') }] : []),
    ...Object.entries(filters).filter(([, f]) => f.value).map(([key, f]) => ({ label: `${COLUMNS.find((c) => c.id === key)?.label ?? key}${key === 'agent' ? '' : ` ${f.mode}`}: ${f.value}`, clear: () => setFilters((old) => ({ ...old, [key]: { ...f, value: '' } })) })),
  ]
  return <>
    <div className="flex h-[calc(100svh-3.5rem)] min-h-0 flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3 sm:px-6">
        <SearchInput aria-label="Search activity" placeholder="Search activity…" value={query} onValueChange={change(setQuery)} className="min-w-44 flex-1 basis-full sm:basis-44" />
        <Popover><PopoverTrigger className={`${control} flex items-center gap-2 hover:bg-muted`}><Filter className="size-3.5" />Filters{(range !== 'all' || direction !== 'all' || sandboxes.length > 0 || verdicts.length > 0 || Object.values(filters).some((f) => f.value)) && <span className="rounded bg-foreground px-1.5 text-[10px] text-background">{Number(range !== 'all') + Number(direction !== 'all') + Number(sandboxes.length > 0) + Number(verdicts.length > 0) + Object.values(filters).filter((f) => f.value).length}</span>}</PopoverTrigger>
          <PopoverContent align="end" className="max-h-[min(38rem,80svh)] w-80 max-w-[calc(100vw-2rem)] overflow-y-auto p-4">
            <p className="text-xs font-medium">Filter activity</p>
            <label className="grid gap-1.5 text-[11px] text-muted-foreground">Time frame<SelectField aria-label="Time range" className={control} value={range} onChange={(e) => change(setRange)(e.target.value)}>{Object.entries(RANGE).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</SelectField></label>
            <label className="grid gap-1.5 text-[11px] text-muted-foreground">Direction
              <SelectField aria-label="Direction" className={control} value={direction} onChange={(e) => change(setDirection)(e.target.value)}><option value="all">All directions</option><option value="unknown">Direction not applicable / unknown</option><option value="out">Outbound</option><option value="in">Inbound</option></SelectField>
            </label>
            <label className="grid gap-1.5 text-[11px] text-muted-foreground">Event type
              <SelectField aria-label="Event category" className={control} value={filters.category?.value || ''} onChange={(e) => change(setFilters)({ ...filters, category: { mode: 'equals', value: e.target.value } })}><option value="">All event types</option>{['Network', 'HTTP', 'Session', 'Configuration', 'Process', 'File', 'Authentication', 'Finding', 'Event', 'Log', 'Unclassified'].map((name) => <option key={name}>{name}</option>)}</SelectField>
            </label>
            <label className="grid gap-1.5 text-[11px] text-muted-foreground">Security severity
              <SelectField aria-label="Security severity" className={control} value={filters.severity?.value || ''} onChange={(e) => change(setFilters)({ ...filters, severity: { mode: 'equals', value: e.target.value } })}><option value="">All severities</option>{['FATAL', 'CRITICAL', 'HIGH', 'MED', 'LOW', 'INFO', 'Not reported'].map((name) => <option key={name}>{name}</option>)}</SelectField>
            </label>
            <label className="grid gap-1.5 text-[11px] text-muted-foreground">Log level
              <SelectField aria-label="Log level" className={control} value={filters.logLevel?.value || ''} onChange={(e) => change(setFilters)({ ...filters, logLevel: { mode: 'equals', value: e.target.value } })}><option value="">All log levels</option>{['ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE', 'Not reported'].map((name) => <option key={name}>{name}</option>)}</SelectField>
            </label>
            <div className="mt-1 border-t pt-3"><p className="mb-2 text-[11px] font-medium">Decision</p><div className="grid grid-cols-2 gap-2">{['allowed', 'denied', 'not reported', 'not applicable'].map((value) => <label key={value} className="flex items-center gap-2 text-xs"><input type="checkbox" checked={verdicts.includes(value)} onChange={() => change(setVerdicts)(verdicts.includes(value) ? verdicts.filter((v) => v !== value) : [...verdicts, value])} />{value}</label>)}</div></div>
            <div className="mt-1 flex flex-col gap-2 border-t pt-3"><p className="text-[11px] font-medium">Sandboxes</p><Choices label="Sandboxes" options={options} selected={sandboxes} onChange={change(setSandboxes)} /></div>
          </PopoverContent>
        </Popover>
        <Popover><PopoverTrigger className={`${control} flex items-center gap-2 hover:bg-muted`}><SlidersHorizontal className="size-3.5" />View<ChevronDown className="size-3" /></PopoverTrigger>
          <PopoverContent align="end" className="w-72 p-3">
            <div className="mb-1 flex gap-1 rounded-md bg-muted p-1" role="group" aria-label="View options">{[['columns', 'Columns'], ['saved', 'Saved views']].map(([id, label]) => <button key={id} aria-pressed={viewPanel === id} onClick={() => setViewPanel(id)} className={`flex-1 rounded px-2 py-1.5 text-xs transition-colors ${viewPanel === id ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>{label}</button>)}</div>
            {viewPanel === 'columns' ? <div>{COLUMNS.map((column) => <label key={column.id} className="flex items-center gap-2 py-1 text-xs"><input type="checkbox" disabled={column.id === 'time'} checked={visibleColumns.includes(column.id)} onChange={(e) => setVisibleColumns(e.target.checked ? [...visibleColumns, column.id] : visibleColumns.filter((id) => id !== column.id))} />{column.label}</label>)}</div> : <div className="flex max-h-80 flex-col gap-3 overflow-auto"><Input aria-label="View name" value={viewName} onChange={(e) => setViewName(e.target.value)} placeholder="Name this investigation…" /><Button size="sm" disabled={!viewName.trim()} onClick={() => { try { const next = [...saved.filter((v) => v.name !== viewName.trim()), { name: viewName.trim(), query: investigation }]; localStorage.setItem('openshell.activity.views', JSON.stringify(next)); setSaved(next); setViewName(''); toast.success('View saved in this browser') } catch { toast.error('Could not save view') } }}>Save view</Button>{saved.map((view) => <div key={view.name} className="flex items-center gap-2"><button className="min-w-0 flex-1 truncate text-left text-xs" onClick={() => applyView(view.query)}>{view.name}</button><button aria-label={`Delete view ${view.name}`} onClick={() => { try { const next = saved.filter((v) => v.name !== view.name); localStorage.setItem('openshell.activity.views', JSON.stringify(next)); setSaved(next) } catch { toast.error('Could not delete view') } }}><X className="size-3" /></button></div>)}{!saved.length && <p className="py-2 text-center text-xs text-muted-foreground">No saved views yet.</p>}</div>}
          </PopoverContent>
        </Popover>
        <DropdownMenu><DropdownMenuTrigger aria-label="Activity actions" className={`${control} flex items-center gap-2 hover:bg-muted`}>Actions<ChevronDown className="size-3" /></DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            <DropdownMenuItem disabled={exporting || Boolean(invalidRange)} onClick={() => openExport('json')}><Download />Export Console JSON</DropdownMenuItem>
            <DropdownMenuItem disabled={exporting || Boolean(invalidRange)} onClick={() => openExport('ocsf')}><Download />Export OCSF JSON</DropdownMenuItem>
            <DropdownMenuItem onClick={() => setDestinationsOpen(true)}><Webhook />Webhooks</DropdownMenuItem>
            {!live.demo && <>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={deleteBusy || !checked.size} variant="destructive" onClick={() => reviewDeletion('selected')}><Trash2 />Delete selected logs{checked.size ? ` (${checked.size})` : ''}</DropdownMenuItem>
              <DropdownMenuItem disabled={deleteBusy || Boolean(invalidRange) || history.loading || !history.total} variant="destructive" onClick={() => reviewDeletion('matching')}><Trash2 />Delete matching logs</DropdownMenuItem>
              <DropdownMenuItem disabled={deleteBusy} variant="destructive" onClick={() => reviewDeletion('all')}><Trash2 />Delete all logs</DropdownMenuItem>
            </>}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {(history.error || live.historyError) && !live.demo && <Notice id="activity:history-error" tone="error" title="History unavailable" actions={<Button size="xs" variant="outline" onClick={history.refresh}>Retry</Button>}>{history.error || live.historyError}</Notice>}
      {range === 'custom' && <div className="flex flex-wrap items-center gap-3 border-b border-border px-6 py-2 text-xs"><label className="flex items-center gap-2">From<input type="datetime-local" aria-label="From time" className={control} value={from} onInput={(e) => change(setFrom)(e.currentTarget.value)} /></label><label className="flex items-center gap-2">To<input type="datetime-local" aria-label="To time" className={control} value={to} onInput={(e) => change(setTo)(e.currentTarget.value)} /></label><span className="text-muted-foreground">{Intl.DateTimeFormat().resolvedOptions().timeZone}</span>{invalidRange && <span role="alert" className="text-red-600">Choose a start or end time; the end must follow the start.</span>}</div>}
      {Boolean(filtering) && <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-6 py-2">{chips.map((chip) => <button key={chip.label} onClick={chip.clear} title={`Remove ${chip.label}`} className="flex max-w-72 items-center gap-2 rounded border border-border bg-muted/40 px-2 py-1 text-[11px]"><span className="truncate">{chip.label}</span><X className="size-3 shrink-0" /></button>)}<Button size="xs" variant="ghost" onClick={clear}>Clear all</Button></div>}
      <div className="flex min-h-10 flex-wrap items-center gap-x-4 gap-y-1 border-b border-border px-6 py-2 text-[11px] text-muted-foreground">
        <span><strong className="font-mono text-foreground">{total.toLocaleString()}</strong> {live.demo ? 'demo events' : 'matching events'}</span>
        <span>{allowed.toLocaleString()} allowed · <span className={denied ? 'text-red-600' : ''}>{denied.toLocaleString()} denied</span> <span className="text-muted-foreground/70">on this page</span></span>
        <button className="flex min-h-10 items-center gap-1.5 rounded px-2 text-xs hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring" onClick={() => { if (held) { setHeld(null); setDemoPagination({ query: pageQuery, page: 0 }); setAnchor(Date.now()); history.refresh(); virtual.scrollToTop() } else hold() }}>{held ? <Play className="size-3" /> : <Pause className="size-3" />}{held ? 'Resume' : 'Pause'}</button>
        {held && <span className="flex items-center gap-2"><span>View paused</span><button className="rounded text-foreground underline underline-offset-4 disabled:opacity-40" disabled={live.demo && !pending} onClick={() => { setHeld(live.demo ? live.events : events); setAnchor(Date.now()); history.refresh(); virtual.scrollToTop() }}>{live.demo ? `${pending.toLocaleString()} new events` : 'Refresh'}</button></span>}
        {checked.size > 0 && <span className="flex items-center gap-2">{checked.size.toLocaleString()} selected<button className="underline" onClick={() => setChecked(new Set())}>Clear selection</button></span>}
        <span className="ml-auto">{Intl.DateTimeFormat().resolvedOptions().timeZone}</span>
      </div>
      <div ref={virtual.ref} onScroll={(e) => { virtual.onScroll(e); if (e.currentTarget.scrollTop > 0) hold() }} tabIndex={0} role="region" aria-label="Activity events" className="min-h-0 flex-1 overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
        <table style={{ minWidth: columns.reduce((sum, c) => sum + c.width, live.demo ? 0 : 40) }} className="w-full table-fixed border-separate border-spacing-0 text-xs" aria-label="Activity" aria-rowcount={shown.length + 1}>
          <colgroup>{!live.demo && <col style={{ width: 52 }} />}{columns.map((c) => <col key={c.id} style={{ width: c.width }} />)}</colgroup>
          <thead className="sticky top-0 z-10 bg-muted"><tr>{!live.demo && <th scope="col" className="h-10 border-b border-border pr-3 pl-4 text-left sm:pl-6"><input type="checkbox" aria-label="Select logs on this page" disabled={!shown.length || shown.length > 5000} checked={shown.length > 0 && shown.every((row) => checked.has(row.key))} ref={(node) => { if (node) node.indeterminate = shown.some((row) => checked.has(row.key)) && !shown.every((row) => checked.has(row.key)) }} onChange={(e) => { hold(); setChecked(e.target.checked ? new Set(shown.map((row) => row.key)) : new Set()) }} /></th>}{columns.map((c) => <th key={c.id} scope="col" aria-sort={sort.key === c.id ? sort.direction === 'asc' ? 'ascending' : 'descending' : 'none'} className="h-10 border-b border-border px-3 text-left font-medium text-muted-foreground"><div className="flex items-center gap-1"><button className="flex h-9 flex-1 items-center gap-1 outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => change(setSort)({ key: c.id, direction: sort.key === c.id && sort.direction === 'asc' ? 'desc' : 'asc' })}>{c.label}{sort.key === c.id && (sort.direction === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}</button>
            <Popover><PopoverTrigger aria-label={`Filter ${c.label}`} className={`rounded p-1 hover:bg-accent ${(c.id === 'time' ? range !== 'all' : c.id === 'sandbox' ? sandboxes.length : c.id === 'verdict' ? verdicts.length : c.id === 'agent' ? agents.length || filters.agent?.value : filters[c.id]?.value) ? 'bg-accent text-foreground' : ''}`}><Filter className="size-3" /></PopoverTrigger><PopoverContent align="start">
              <p className="text-xs font-medium">Filter {c.label.toLowerCase()}</p>
              {c.id === 'agent' ? <div role="group" aria-label="Observed agents" className="max-h-64 overflow-y-auto">
                <div className="mb-1 flex items-center justify-between px-2 text-[11px] text-muted-foreground"><span>{agents.length ? `${agents.length} selected` : 'All agents'}</span><button className="underline" onClick={() => { hold(); setAgents([]); setFilters(({ agent, ...rest }) => rest) }}>Clear</button></div>
                {agentOptions.map((name) => <label key={name} className="flex min-h-8 cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-muted">
                  <input type="checkbox" checked={agents.includes(name)} onChange={() => { hold(); setFilters(({ agent, ...rest }) => rest); setAgents((current) => current.includes(name) ? current.filter((value) => value !== name) : [...current, name]) }} className="accent-foreground" />
                  <AgentLabel agent={AGENT_LABELS[name] ?? { name }} />
                </label>)}
                {!agentOptions.length && <p className="px-2 py-3 text-xs text-muted-foreground">No agents in the logs</p>}
              </div> : c.id === 'sandbox' ? <Choices label="Sandboxes" options={options} selected={sandboxes} onChange={change(setSandboxes)} /> : c.id === 'verdict' ? <Choices label="Decisions" options={['allowed', 'denied', 'not reported', 'not applicable']} selected={verdicts} onChange={change(setVerdicts)} /> : c.id === 'time' ? <><SelectField aria-label="Filter time" className={control} value={range} onChange={(e) => change(setRange)(e.target.value)}>{Object.entries(RANGE).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</SelectField><p className="text-[11px] text-muted-foreground">Custom dates appear above the table.</p></> : <>
                <SelectField aria-label={`${c.label} match mode`} className={control} value={filters[c.id]?.mode ?? 'contains'} onChange={(e) => change(setFilters)({ ...filters, [c.id]: { value: filters[c.id]?.value ?? '', mode: e.target.value } })}><option value="equals">Equals</option><option value="contains">Contains</option><option value="excludes">Excludes</option></SelectField>
                <Input aria-label={`${c.label} filter value`} placeholder={`Filter ${c.label.toLowerCase()}…`} value={filters[c.id]?.value ?? ''} onChange={(e) => change(setFilters)({ ...filters, [c.id]: { mode: filters[c.id]?.mode ?? 'contains', value: e.target.value } })} className="h-8 text-xs" />
              </>}
            </PopoverContent></Popover>
          </div></th>)}</tr></thead>
          <tbody>
            {virtual.paddingTop > 0 && <tr aria-hidden="true"><td colSpan={columns.length + (live.demo ? 0 : 1)} style={{ height: virtual.paddingTop, padding: 0 }} /></tr>}
            {shown.slice(virtual.start, virtual.end).map((row, i) => <tr key={row.key} aria-rowindex={virtual.start + i + 2} onClick={() => { hold(); setSelected(row) }} className={`group cursor-pointer hover:bg-muted/70 ${selected?.key === row.key ? 'bg-accent' : 'bg-card'}`}>
              {!live.demo && <td className="h-12 border-b border-border/60 pr-3 pl-4 sm:pl-6" onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label={`Select log ${row.values.sandbox} ${row.values.time}`} checked={checked.has(row.key)} disabled={!checked.has(row.key) && checked.size >= 5000} onChange={() => toggleChecked(row.key)} /></td>}
              {columns.map((c) => <td key={c.id} className={`h-12 border-b border-border/60 px-3 py-0 font-mono text-[11px] ${c.id === 'verdict' ? row.values.verdict === 'denied' ? 'text-red-600' : row.values.verdict === 'allowed' ? 'text-emerald-700' : 'text-muted-foreground' : c.id === 'destination' ? 'text-foreground' : 'text-muted-foreground'}`}>
                {c.id === 'time' ? <button aria-label={`Inspect event ${row.values.sandbox} ${row.values.time}`} aria-haspopup="dialog" className="h-8 w-full truncate text-left outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={(e) => { e.stopPropagation(); hold(); setSelected(row) }}>{timestamp(row.values.time)}</button> : c.id === 'action' ? <span className="block truncate" title={`${row.values.category} · ${row.values.action} · ${row.values.process}`}><span className="block truncate text-foreground">{row.values.category} · {row.event.method || row.event.action || 'Not reported'}</span><span className="block truncate text-[10px]">{row.values.process || row.event.detail || row.event.message || 'Process not reported'}</span></span> : c.id === 'agent' && row.agent ? <span className="font-sans text-foreground"><AgentLabel agent={row.agent} /></span> : <span className="block truncate" title={row.values[c.id]}>{row.values[c.id] || '-'}</span>}
              </td>)}
            </tr>)}
            {virtual.end < shown.length && <tr aria-hidden="true"><td colSpan={columns.length + (live.demo ? 0 : 1)} style={{ height: (shown.length - virtual.end) * 48, padding: 0 }} /></tr>}
          </tbody>
        </table>
        {!shown.length && <div className="py-20 text-center text-sm text-muted-foreground"><p>{history.error && !live.demo ? 'Could not load retained events' : history.loading && !live.demo ? 'Searching retained events…' : invalidRange ? 'Set a valid time range' : filtering ? 'No matching events in available history' : 'No activity available'}</p>{Boolean(filtering) && <Button variant="outline" size="sm" className="mt-3" onClick={clear}>Clear filters</Button>}</div>}
      </div>
      {total > PAGE_SIZE && <nav aria-label="Activity pagination" className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-border bg-card px-6 py-3">
        <span aria-live="polite" className="text-xs tabular-nums text-muted-foreground">{(page * PAGE_SIZE + 1).toLocaleString()}-{Math.min((page + 1) * PAGE_SIZE, total).toLocaleString()} of {total.toLocaleString()} logs</span>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" aria-label="First page" disabled={page === 0 || (!live.demo && history.loading)} onClick={() => navigatePage(0)}>First</Button>
          <Button variant="outline" size="sm" aria-label="Previous page" disabled={page === 0 || (!live.demo && history.loading)} onClick={() => navigatePage(page - 1)}>Previous</Button>
          <span aria-live="polite" className="px-2 text-xs tabular-nums text-muted-foreground">{!live.demo && history.loading ? 'Loading…' : `Page ${page + 1} of ${pageCount.toLocaleString()}`}</span>
          <Button variant="outline" size="sm" aria-label="Next page" disabled={page >= pageCount - 1 || (!live.demo && history.loading)} onClick={() => navigatePage(page + 1)}>Next</Button>
          <Button variant="outline" size="sm" aria-label="Last page" disabled={page >= pageCount - 1 || (!live.demo && history.loading)} onClick={() => navigatePage(pageCount - 1)}>Last</Button>
        </div>
      </nav>}
    </div>
    <Dialog open={Boolean(exportOptions)} onOpenChange={(open) => { if (!open) setExportOptions(null) }}>
      <DialogContent className="sm:max-w-md max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Export {exportOptions?.format === 'ocsf' ? 'OCSF JSON' : 'Console JSON'}</DialogTitle><DialogDescription>Your current columns and time frame are ready to export. Other table filters still apply.</DialogDescription></DialogHeader>
        {exportOptions && <>
          <label className="grid gap-2 text-xs font-medium">Time frame<SelectField className={control} value={exportOptions.range} onChange={(e) => setExportOptions({ ...exportOptions, range: e.target.value })}>{Object.entries(RANGE).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</SelectField></label>
          {exportOptions.range === 'custom' && <div className="grid gap-3 sm:grid-cols-2">{['from', 'to'].map((key) => <label key={key} className="grid gap-1 text-xs"><span>{key === 'from' ? 'From' : 'To'}</span><input type="datetime-local" className={control + ' w-full min-w-0'} value={exportOptions[key]} onChange={(e) => setExportOptions({ ...exportOptions, [key]: e.target.value })} /></label>)}<p className="text-[11px] text-muted-foreground sm:col-span-2">{Intl.DateTimeFormat().resolvedOptions().timeZone} · Leave one end empty for an open range.</p></div>}
          <fieldset className="space-y-3"><legend className="text-xs font-medium">Columns</legend><div className="grid grid-cols-2 gap-3">{COLUMNS.map((column) => <label key={column.id} className="flex items-center gap-2 text-xs"><input type="checkbox" checked={exportOptions.columns.includes(column.id)} disabled={column.id === 'time' && exportOptions.format === 'ocsf'} onChange={(e) => setExportOptions({ ...exportOptions, columns: e.target.checked ? [...exportOptions.columns, column.id] : exportOptions.columns.filter((id) => id !== column.id) })} />{column.label}</label>)}</div></fieldset>
          {exportOptions.format === 'ocsf' && <p className="text-[11px] text-muted-foreground">OCSF includes the required event time and schema fields alongside your selected columns.</p>}
          {exportInvalid && <p role="alert" className="text-xs text-destructive">Choose at least one column and a valid time frame.</p>}
          <DialogFooter><Button variant="outline" onClick={() => setExportOptions(null)}>Cancel</Button><Button disabled={exporting || exportInvalid} onClick={exportMatches}><Download />{exporting ? 'Exporting…' : 'Export'}</Button></DialogFooter>
        </>}
      </DialogContent>
    </Dialog>
    <AlertDialog open={Boolean(deletion)} onOpenChange={(open) => { if (!open && !deleteBusy) setDeletion(null) }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{deletion?.mode === 'all' ? 'Delete all retained logs?' : deletion?.mode === 'matching' ? 'Delete matching logs?' : 'Delete selected logs?'}</AlertDialogTitle><AlertDialogDescription>{deletion?.count.toLocaleString()} log{deletion?.count === 1 ? '' : 's'} will be permanently removed from Activity and pending webhook delivery. This cannot be undone.</AlertDialogDescription></AlertDialogHeader>
      <p className="text-xs leading-relaxed text-muted-foreground">{deletion?.mode === 'all' ? 'This includes every sandbox and ignores the current filters. ' : ''}New logs arriving after this review will be kept. Copies in sandbox files, exports, or external systems are not deleted; a webhook request already in flight may still arrive.</p>
      {deleteError && <p role="alert" className="text-xs text-destructive">{deleteError}</p>}
      <AlertDialogFooter><AlertDialogCancel disabled={deleteBusy}>Cancel</AlertDialogCancel><AlertDialogAction variant="destructive" disabled={deleteBusy || !deletion?.count || Boolean(deleteError)} onClick={confirmDeletion}>{deleteBusy ? 'Deleting…' : `Delete ${deletion?.count.toLocaleString()} log${deletion?.count === 1 ? '' : 's'}`}</AlertDialogAction></AlertDialogFooter>
    </AlertDialogContent></AlertDialog>
    <Sheet open={destinationsOpen} onOpenChange={setDestinationsOpen}><SheetContent className="gap-0 data-[side=right]:w-full sm:data-[side=right]:max-w-2xl"><SheetHeader className="border-b border-border pr-12"><SheetTitle className="flex items-center gap-2"><Webhook aria-hidden="true" className="size-4 text-muted-foreground" strokeWidth={1.5} />Webhooks</SheetTitle><SheetDescription>Send activity to an HTTPS endpoint.</SheetDescription></SheetHeader>{destinationsOpen && <ActivityDestinations />}</SheetContent></Sheet>
    <Sheet open={Boolean(selected)} onOpenChange={(open) => { if (!open) setSelected(null) }}><SheetContent className="w-full gap-0 sm:max-w-lg"><SheetHeader className="border-b border-border pr-12"><SheetTitle>Event details</SheetTitle><SheetDescription>Full values from this event. The activity view stays paused.</SheetDescription></SheetHeader>{selected && <div className="min-h-0 flex-1 space-y-5 overflow-auto p-5">
      <div className="flex flex-wrap gap-2">{[[selected.event.scope ? 'scope' : 'sandbox', selected.event.scope || selected.values.sandbox, 'Sandbox timeline'], ['destination', selected.values.destination, 'Same target'], ['process', selected.values.process, 'Same executable'], ['policy', selected.values.policy, 'Same policy'], ['session', selected.values.session, 'Same session'], ['correlation', selected.values.correlation, 'Same correlation']].filter(([, value]) => value).map(([key, value, label]) => <Button key={key} size="xs" variant="outline" onClick={() => pivot(key, value)}>{label}</Button>)}</div>
      {!live.demo && <Button size="sm" variant="destructive" disabled={deleteBusy} onClick={() => reviewDeletion('selected', [selected.key])}><Trash2 />Delete log</Button>}
      <p className="text-[11px] text-muted-foreground">Pivots match recorded fields. An executable match does not prove the same process instance.</p>
      <dl className="space-y-4">{[['Timestamp', selected.values.time], ['Sandbox', selected.values.sandbox], ['Sandbox ID', selected.values.sandboxId], ['Collection scope', selected.event.scope], ['Direction', selected.values.direction], ['Category', selected.values.category], ['Security severity', selected.values.severity], ['Log level', selected.values.logLevel], ['Decision', selected.values.verdict], ['Agent', selected.values.agent], ['Attribution', selected.agent ? 'Executable name match only; initiating agent and parent process are not reported.' : 'Initiating agent not reported by this event.'], ['Initiator', 'Not reported'], ['Session ID', selected.values.session], ['Correlation ID', selected.values.correlation], ['Action', selected.values.action], ['Executable', selected.event.binary], ['Destination', selected.values.destination], ['Policy', selected.event.policy], ['Policy revision at event time', selected.event.policyVersion ?? 'Not reported'], ['Enforcement mode at event time', selected.event.enforcement ?? 'Not reported'], ['Event ID', selected.key], ['Source cursor', selected.event.sourceCursor], ['Identity evidence', selected.event.idSource || 'No source event ID reported'], ['Received at', selected.event.receivedAt], ['Source', selected.event.source], ['Parser target', selected.event.target], ['Reason', selected.event.reason], ['Why', selected.values.why]].map(([label, value]) => <div key={label}><dt className="mb-1 text-[11px] text-muted-foreground">{label}</dt><dd className="flex items-start gap-2"><span className="min-w-0 flex-1 break-all font-mono text-xs">{label === 'Agent' && selected.agent ? <AgentLabel agent={selected.agent} /> : value || '-'}</span>{value && <CopyButton label={label} value={value} />}</dd></div>)}</dl>
      <div><div className="mb-2 flex items-center justify-between"><h3 className="text-xs font-medium">Raw event</h3><CopyButton label="raw event" value={JSON.stringify(selected.event, null, 2)} /></div><pre className="overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-muted/40 p-3 text-[11px]">{JSON.stringify(selected.event, null, 2)}</pre></div>
    </div>}</SheetContent></Sheet>
  </>
}
function CopyButton({ label, value }) {
  const [copied, setCopied] = React.useState(false)
  React.useEffect(() => { if (copied) { const timer = setTimeout(() => setCopied(false), 1500); return () => clearTimeout(timer) } }, [copied])
  return <button className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted" aria-label={`Copy ${label}`} onClick={async () => { try { await navigator.clipboard.writeText(value); setCopied(true) } catch { toast.error('Could not copy to clipboard') } }}>{copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}</button>
}
