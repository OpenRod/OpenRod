import * as React from "react"
import { ArrowUpRight, ArrowUp, ArrowDown, Box, Check, HardDrive, ListFilter, Plus, RefreshCw, Trash2, X } from "lucide-react"
import { toast } from "sonner"
import { createApi } from "@/lib/api"
import { useCompute } from "@/lib/compute"
import { useInventory } from "@/lib/inventory"
import { LocationProvider, useApi, useLocation } from "@/lib/location-context"
import { locationLabel, resourceKey } from "@/lib/locations"
import { LocationBadge } from "@/components/location-badge"
import { Notice } from "@/components/notice"
import { PlacementBadge, PlacementPill } from "@/components/placement-badge"
import { PLACEMENTS, placementOf } from "@/lib/placement"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { SearchInput } from "@/components/ui/search-input"
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { BoxCountChart, bucketBoxes } from "@/components/box-count-chart"
import { NumberTicker } from "@/components/ui/number-ticker"
import { SandboxSheet } from "@/components/sandbox-sheet"
import { CreateSandboxDialog } from "@/components/create-sandbox-dialog"
import { BOX_HANDOFF } from "@/components/sandbox-creation-notices"
import { sandboxCreations } from "@/lib/sandbox-creations"
import { useVirtualRows } from "@/hooks/use-virtual-rows"
import { useDemoFleet } from "@/hooks/use-demo-fleet"
import { useLive } from "@/lib/live"
import { PHASE_LABEL, STATUS, STATUS_ORDER, elapsedSince, imageName, ownerOf, statusOf, styleOf, summarize, uptimeOf } from "@/lib/sandboxes"

export { BOX_HANDOFF }
const EMPTY = []
const PREVIEW_LOCATION = { context: '["preview","default"]', gateway: "preview", workspace: "default", label: "Local", remote: false, connected: true }
const ROW_HEIGHT = 40
const FILTERS = ["all", "running", "sleeping", "provisioning", "error", "unknown"]
const locationKey = (location) => location?.id ?? location?.context
const keyOf = resourceKey
const nameKey = (sandbox) => JSON.stringify([locationKey(sandbox.location), sandbox.name])
const number = (value) => value.toLocaleString("en-US")
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })
const COLUMNS = [{ id: "name", label: "Sandbox", width: "26%" }, { id: "type", label: "Type", width: "11%", filter: "values" }, { id: "phase", label: "Status", width: "11%", filter: "values" }, { id: "owner", label: "Owner", width: "12%", filter: "values" }, { id: "image", label: "Image", width: "22%", filter: "values" }, { id: "startedAt", label: "Uptime", width: "8%" }, { id: "createdAt", label: "Created", width: "10%", filter: "recent" }]
const RECENT = [{ value: "1", label: "Last 24 hours" }, { value: "7", label: "Last 7 days" }, { value: "30", label: "Last 30 days" }]
const NO_FILTERS = { type: [], phase: [], owner: [], image: [], createdAt: "" }
// The value a row is filtered on, for each column with a value list.
// The same marks the rows use, so a filter reads like the column it narrows.
const PLACEMENT_BY_LABEL = Object.fromEntries(Object.entries(PLACEMENTS).map(([type, placement]) => [placement.label, type]))
const ImageMark = () => <HardDrive aria-hidden="true" strokeWidth={1.5} className="size-3.5 shrink-0 text-muted-foreground" />
const FILTER_ITEM = {
  type: (item) => <PlacementPill type={PLACEMENT_BY_LABEL[item.value]} />,
  phase: (item) => <span className="flex min-w-0 items-center gap-1.5"><span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${STATUS[item.value].bar}`} /><span className="truncate">{item.label}</span></span>,
  image: (item) => <span className="flex min-w-0 items-center gap-1.5"><ImageMark /><span className="truncate font-mono text-[11px]">{item.label}</span></span>,
}
const filterValue = { type: (row) => row.type, phase: (row) => statusOf(row.sandbox.phase), owner: (row) => row.owner, image: (row) => row.image }
// Synthetic fleets spread across every placement so the Type column can be judged.
const DEMO_PLACEMENTS = Object.keys(PLACEMENTS)

export function SandboxesView({ onNavigate, allowRemote = false, createRequest = 0, onCreateRequestHandled }) {
  const api = useApi()
  const compute = useCompute()
  const live = useDemoFleet(useLive())
  const inventory = useInventory()
  const { locations } = inventory
  const inheritedLocation = useLocation()
  const [selectedContext, setSelectedContext] = React.useState(null)
  const defaultContext = locationKey(inheritedLocation) ?? selectedContext
  const locationFilter = locationKey(inheritedLocation) ?? ""
  const [creationLocation, setCreationLocation] = React.useState(null)
  const [handoff, setHandoff] = React.useState(null)
  const canConnect = allowRemote
  React.useEffect(() => {
    let alive = true
    api.contextKey().then((context) => { if (alive) setSelectedContext(JSON.stringify([api.target, context])) }).catch(() => {})
    return () => { alive = false }
  }, [api])
  const defaultLocation = locations.find((location) => locationKey(location) === defaultContext)
  const availableLocation = locations.find((location) => locationKey(location) === locationFilter && location.connected)
    ?? (defaultLocation?.connected ? defaultLocation : null)
    ?? locations.find((location) => location.target === api.target && !location.remote && location.connected)
    ?? locations.find((location) => location.target === api.target && location.connected)
  const chosenLocation = locations.find((location) => locationKey(location) === locationKey(creationLocation)) ?? creationLocation ?? availableLocation
  const jobs = React.useSyncExternalStore(sandboxCreations.subscribe, sandboxCreations.getSnapshot)
  // Created sandboxes show at once, before the inventory first reports them.
  const creations = React.useMemo(() => jobs.filter((job) => job.status === "created" && !job.reported).map((job) => job.sandbox), [jobs])
  const reportedSandboxes = React.useMemo(() => live.demo
    ? (live.sandboxes ?? EMPTY).map((sandbox, index) => { const location = defaultLocation ?? availableLocation ?? PREVIEW_LOCATION; const placement = DEMO_PLACEMENTS[index % DEMO_PLACEMENTS.length]; return { ...sandbox, location: placement === placementOf(location) ? location : { ...location, placement, host: `${placement}-demo` } } })
    : inventory.sandboxes, [live.demo, live.sandboxes, defaultLocation, availableLocation, inventory.sandboxes])
  const sandboxes = React.useMemo(() => {
    const reported = new Set(reportedSandboxes.map(nameKey))
    return [...creations.filter((sandbox) => !reported.has(nameKey(sandbox))).map((sandbox) => ({ ...sandbox, location: locations.find((location) => locationKey(location) === locationKey(sandbox.location)) ?? sandbox.location })), ...reportedSandboxes]
  }, [reportedSandboxes, creations, locations])
  const [query, setQuery] = React.useState("")
  const [filters, setFilters] = React.useState(NO_FILTERS)
  const setFilter = (column, value) => setFilters((current) => ({ ...current, [column]: value }))
  const [sort, setSort] = React.useState({ key: "name", direction: "asc" })
  const deferredQuery = React.useDeferredValue(query)
  const [opened, setOpened] = React.useState(null)
  const [selected, setSelected] = React.useState(() => new Set())
  const [deleteTargets, setDeleteTargets] = React.useState(null)
  const [deleting, setDeleting] = React.useState(false)
  const deletionInFlight = React.useRef(false)
  const [deleteErrors, setDeleteErrors] = React.useState([])
  const [creating, setCreating] = React.useState(Boolean(compute?.createRequested))
  React.useEffect(() => {
    if (compute?.createRequested) { setCreating(true); compute.requestCreate(false) }
  }, [compute?.createRequested])
  const [now, setNow] = React.useState(Date.now)
  const search = React.useRef(null)
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000)
    const onKey = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); search.current?.focus() }
    }
    window.addEventListener("keydown", onKey)
    const takeHandoff = () => {
      try {
        const stored = sessionStorage.getItem(BOX_HANDOFF)
        sessionStorage.removeItem(BOX_HANDOFF)
        if (stored) {
          let value
          try { value = JSON.parse(stored) } catch { /* Legacy handoffs contain a plain name. */ }
          setHandoff(value && typeof value.name === "string" ? { name: value.name, context: locationKey(value.location) ?? (value.context && value.target ? JSON.stringify([value.target, value.context]) : value.context) } : { name: stored })
        }
      } catch { /* optional storage */ }
    }
    // A copy between local and cloud announces the new sandbox directly.
    const receiveHandoff = (event) => {
      const value = event.detail
      if (typeof value?.name !== "string") return
      setHandoff({ name: value.name, context: value.location?.id ?? (value.context ? JSON.stringify([value.target ?? api.target, value.context]) : undefined) })
      inventory.refresh()
    }
    takeHandoff()
    window.addEventListener("openrod-sandbox-handoff", receiveHandoff)
    window.addEventListener(BOX_HANDOFF, takeHandoff)
    return () => { clearInterval(timer); window.removeEventListener("keydown", onKey); window.removeEventListener(BOX_HANDOFF, takeHandoff); window.removeEventListener("openrod-sandbox-handoff", receiveHandoff) }
  }, [])
  React.useEffect(() => {
    const context = handoff?.context ?? defaultContext
    if (!handoff || !context || inventory.loading) return
    const sandbox = sandboxes.find((sandbox) => sandbox.name === handoff.name && locationKey(sandbox.location) === context)
    if (!sandbox?.location.connected) return
    setOpened(sandbox)
    setHandoff(null)
    try { sessionStorage.removeItem(BOX_HANDOFF) } catch {}
  }, [handoff, defaultContext, inventory.loading, sandboxes])
  // A sandbox created while this page is open is brought into view.
  const shown = React.useRef(null)
  React.useEffect(() => {
    const created = jobs.filter((job) => job.status === "created")
    if (!shown.current) { shown.current = new Set(created.map((job) => job.id)); return }
    const fresh = created.filter((job) => !shown.current.has(job.id))
    if (!fresh.length) return
    fresh.forEach((job) => shown.current.add(job.id))
    setOpened(null)
    setQuery(""); setFilters(NO_FILTERS)
    setSort({ key: "createdAt", direction: "desc" })
    inventory.refresh()
  }, [jobs])
  const all = React.useMemo(() => summarize(sandboxes), [sandboxes])
  const indexed = React.useMemo(() => sandboxes.map((sandbox) => ({ sandbox, owner: ownerOf(sandbox), type: PLACEMENTS[placementOf(sandbox.location)].label, image: imageName(sandbox.image, sandbox.imageTemplateName), search: [sandbox.name, sandbox.id, sandbox.image, sandbox.imageTemplateName, locationLabel(sandbox.location), PLACEMENTS[placementOf(sandbox.location)].label, ownerOf(sandbox), ...(sandbox.providers ?? [])].join(" ").toLowerCase() })), [sandboxes])
  // Every value a filterable column holds, with how many sandboxes have it.
  const columnValues = React.useMemo(() => Object.fromEntries(Object.entries(filterValue).map(([column, of]) => {
    const counts = new Map()
    for (const row of indexed) counts.set(of(row), (counts.get(of(row)) ?? 0) + 1)
    const values = [...counts.keys()].sort(column === "phase" ? (a, b) => STATUS_ORDER.indexOf(a) - STATUS_ORDER.indexOf(b) : collator.compare)
    return [column, values.map((value) => ({ value, label: column === "phase" ? STATUS[value].label : value, count: counts.get(value) }))]
  })), [indexed])
  const ordered = React.useMemo(() => {
    const q = deferredQuery.trim().toLowerCase()
    const since = filters.createdAt ? now - Number(filters.createdAt) * 86400000 : null
    const matched = indexed.filter((row) => (!locationFilter || locationKey(row.sandbox.location) === locationFilter)
      && Object.entries(filterValue).every(([column, of]) => !filters[column].length || filters[column].includes(of(row)))
      && (since === null || Date.parse(row.sandbox.createdAt) >= since)
      && (!q || row.search.includes(q)))
    const value = (row) => sort.key === "owner" || sort.key === "image" || sort.key === "type" ? row[sort.key] : sort.key === "startedAt" ? row.sandbox.phase === "ready" ? row.sandbox.startedAt : null : row.sandbox[sort.key]
    return matched.sort((a, b) => {
      const av = value(a), bv = value(b)
      if (!av && bv) return 1
      if (av && !bv) return -1
      const delta = collator.compare(av ?? "", bv ?? "")
      return (sort.direction === "asc" ? delta : -delta) || collator.compare(a.sandbox.name, b.sandbox.name)
    })
  }, [indexed, filters, locationFilter, deferredQuery, sort, now])
  // Keep selection tied to identity across sorting, filters, and live updates.
  React.useEffect(() => {
    const available = new Set(sandboxes.filter((sandbox) => sandbox.location?.connected && !live.demo).map(keyOf))
    setSelected((current) => {
      const next = new Set([...current].filter((key) => available.has(key)))
      return next.size === current.size ? current : next
    })
  }, [sandboxes, live.demo])
  const selectedBoxes = React.useMemo(() => sandboxes.filter((sandbox) => sandbox.location?.connected && selected.has(keyOf(sandbox))), [sandboxes, selected])
  const selectable = ordered.filter((row) => row.sandbox.location?.connected && !live.demo)
  const matchingSelected = selectable.reduce((count, row) => count + Number(selected.has(keyOf(row.sandbox))), 0)
  const allMatchingSelected = selectable.length > 0 && matchingSelected === selectable.length
  const toggleSelected = React.useCallback((sandbox) => {
    if (!sandbox.location?.connected) return
    setSelected((current) => {
      const next = new Set(current), key = keyOf(sandbox)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])
  const toggleMatching = () => setSelected((current) => {
    const next = new Set(current)
    for (const { sandbox } of selectable) {
      if (allMatchingSelected) next.delete(keyOf(sandbox))
      else next.add(keyOf(sandbox))
    }
    return next
  })
  async function deleteSelected() {
    if (deletionInFlight.current || live.demo || !deleteTargets?.length) return
    deletionInFlight.current = true
    setDeleting(true)
    setDeleteErrors([])
    const succeeded = new Set(), failures = []
    // Bound concurrent requests even when selecting a large filtered fleet.
    let cursor = 0
    const worker = async () => {
      while (cursor < deleteTargets.length) {
        const sandbox = deleteTargets[cursor++]
        try {
          const location = locations.find((location) => locationKey(location) === locationKey(sandbox.location))
          if (!location?.connected) throw new Error("Location is disconnected. Reconnect before deleting.")
          await createApi(compute?.localViewer ? location.target ?? "local" : api.target, api.signal, location.context).lifecycle(sandbox.name, "delete")
          succeeded.add(keyOf(sandbox))
        } catch (error) {
          failures.push({ key: keyOf(sandbox), name: sandbox.name, location: sandbox.location, message: error.message })
        }
      }
    }
    try {
      await Promise.all(Array.from({ length: Math.min(4, deleteTargets.length) }, worker))
      setSelected((current) => new Set([...current].filter((key) => !succeeded.has(key))))
      setDeleteErrors(failures)
      if (succeeded.size) toast.success(`Deletion requested for ${number(succeeded.size)} ${succeeded.size === 1 ? "sandbox" : "sandboxes"}`)
      if (failures.length) toast.error(`${number(failures.length)} ${failures.length === 1 ? "sandbox could" : "sandboxes could"} not be deleted. Review the errors and retry.`)
      inventory.refresh()
    } finally {
      deletionInFlight.current = false
      setDeleting(false)
      setDeleteTargets(null)
    }
  }
  const virtual = useVirtualRows({ count: ordered.length, rowHeight: ROW_HEIGHT })
  React.useEffect(() => { virtual.scrollToTop() }, [deferredQuery, filters, locationFilter, sort])
  const points = React.useMemo(() => bucketBoxes(sandboxes, 30, now), [sandboxes, now])
  const clearFilters = () => { setQuery(""); setFilters(NO_FILTERS) }
  const filtering = query || Object.values(filters).some((value) => value.length)
  const loading = sandboxes.length === 0 && inventory.loading && !live.demo
  const unreachable = sandboxes.length === 0 && inventory.error
  const openedSandbox = opened && (sandboxes.find((sandbox) => keyOf(sandbox) === keyOf(opened))
    ?? (opened.id == null ? sandboxes.find((sandbox) => nameKey(sandbox) === nameKey(opened)) : null)
    ?? opened)
  const openedLocation = openedSandbox && (locations.find((location) => locationKey(location) === locationKey(openedSandbox.location)) ?? openedSandbox.location)
  const openedLive = openedSandbox ? {
    ...live,
    sandboxes: [openedSandbox],
    events: locationKey(openedLocation) === defaultContext ? live.events : EMPTY,
    overview: locationKey(openedLocation) === defaultContext ? live.overview : { gateway: { name: openedLocation?.gateway, workspace: openedLocation?.workspace, remote: openedLocation?.remote } },
    refresh: inventory.refresh,
  } : null
  const beginCreation = () => { setCreationLocation(availableLocation ?? null); setCreating(true) }
  React.useEffect(() => { if (createRequest) { beginCreation(); onCreateRequestHandled?.() } }, [createRequest])

  return (
    <>
      <div className="flex h-[calc(100svh-3.5rem)] min-h-0 flex-col overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 px-4 pt-4 pb-3 sm:px-6">
          <div className="flex flex-wrap gap-1" role="group" aria-label="Sandbox status">
            {FILTERS.filter((key) => ["all", "running", "sleeping"].includes(key) || all.status[key] > 0).map((key) => <button key={key} aria-pressed={key === "all" ? !filters.phase.length : filters.phase.length === 1 && filters.phase[0] === key} onClick={() => setFilter("phase", key === "all" ? [] : [key])}
              className={`rounded-md px-3 py-1.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${(key === "all" ? !filters.phase.length : filters.phase.length === 1 && filters.phase[0] === key) ? "bg-accent/70" : "hover:bg-muted/60"}`}>
              <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">{key !== "all" && <span aria-hidden="true" className={`size-1.5 rounded-full ${STATUS[key].bar}`} />}{key === "all" ? "Sandboxes" : STATUS[key].label}</span>
              <span className="mt-1 block font-mono text-lg leading-none tabular-nums"><NumberTicker value={key === "all" ? all.total : all.status[key]} /></span>
            </button>)}
          </div>
          <div className="ml-auto hidden w-64 px-3 lg:block"><BoxCountChart points={points} height={34} title="Boxes · 30d" /></div>
        </div>
        <div className="flex h-[3px] shrink-0 overflow-hidden" role="img" aria-label={Object.entries(all.status).map(([key, value]) => `${value} ${STATUS[key].label}`).join(", ")}>
          {Object.entries(all.status).map(([key, value]) => value > 0 && <span key={key} className={STATUS[key].strip} style={{ width: `${value / all.total * 100}%` }} />)}
        </div>
        {inventory.error && sandboxes.length > 0 && <Notice id="sandboxes:inventory-error" tone="warning" title="Inventory refresh failed" actions={<Button size="xs" variant="outline" onClick={inventory.refresh}>Retry</Button>}>Showing the last reading. {inventory.error}</Notice>}
        {locations.filter((location) => !location.connected).map((location) => <LocationReconnect key={locationKey(location)} location={location} onReconnected={inventory.refresh} />)}
        {live.demo && <p className="border-b border-border px-6 py-2 text-xs text-amber-700">Preview · synthetic sandbox data</p>}
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2 sm:px-6">
          <SearchInput ref={search} value={query} onValueChange={setQuery} placeholder="Search name, owner, image…" aria-label="Search sandboxes" className="mr-auto w-full sm:w-64" />
          {filtering && <Button variant="ghost" size="sm" onClick={clearFilters}><X className="size-3" />Clear</Button>}
          <Button variant="ghost" size="icon-sm" aria-label="Refresh sandboxes" onClick={inventory.refresh}><RefreshCw className="size-3.5" /></Button>
          <Button size="sm" disabled={!availableLocation && !canConnect} onClick={beginCreation} className="bg-[var(--action)] text-[var(--action-foreground)] hover:bg-[var(--action)]/90"><Plus className="size-3.5" />New sandbox</Button>
        </div>
        {selectedBoxes.length > 0 && <div className="flex flex-wrap items-center gap-3 border-b border-border bg-accent/30 px-6 py-2">
          <span role="status" className="mr-auto text-xs"><strong>{number(selectedBoxes.length)}</strong> selected{selectedBoxes.length > matchingSelected && <span className="text-muted-foreground"> · {number(selectedBoxes.length - matchingSelected)} outside current filters</span>}</span>
          <Button variant="ghost" size="sm" disabled={deleting} onClick={() => setSelected(new Set())}>Clear selection</Button>
          <Button variant="destructive" size="sm" disabled={deleting || live.demo} title={live.demo ? "Deletion is unavailable for synthetic preview data" : undefined} onClick={() => setDeleteTargets([...selectedBoxes])}><Trash2 className="size-3.5" />{deleting ? "Deleting…" : "Delete selected"}</Button>
        </div>}
        {deleteErrors.length > 0 && <Notice id="sandboxes:delete-errors" tone="error" title="Some sandboxes could not be deleted" onDismiss={() => setDeleteErrors([])} dismissLabel="Dismiss deletion errors">
          <p>Failed boxes remain selected for retry.</p>
          <ul className="mt-1 max-h-28 overflow-auto">{deleteErrors.map((error) => <li key={error.key}><strong className="text-foreground">{error.name}</strong> <LocationBadge location={error.location} />: {error.message}</li>)}</ul>
        </Notice>}
        <div ref={virtual.ref} onScroll={virtual.onScroll} tabIndex={0} role="region" aria-label="Sandbox inventory" className="min-h-0 flex-1 overflow-auto overscroll-contain outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
          {loading ? <p role="status" className="py-20 text-center text-sm text-muted-foreground">Loading sandboxes…</p>
            : unreachable ? <div role="alert" className="py-16 text-center"><p>Inventory unavailable</p><p className="mt-2 text-sm text-muted-foreground">{inventory.error}</p><Button variant="outline" onClick={inventory.refresh} className="mt-4">Retry</Button></div>
            : !ordered.length ? <div className="py-20 text-center"><Box className="mx-auto mb-3 size-6 text-muted-foreground" /><p className="text-sm">{sandboxes.length ? "No matching sandboxes" : "No sandboxes yet"}</p><Button variant="outline" disabled={!sandboxes.length && !availableLocation && !canConnect} className="mt-4" onClick={() => sandboxes.length ? clearFilters() : beginCreation()}>{sandboxes.length ? "Clear filters" : "Create sandbox"}</Button></div>
            : <table aria-label="Sandboxes" aria-rowcount={ordered.length + 1} className="w-full min-w-[1040px] table-fixed border-separate border-spacing-0 text-xs">
              <colgroup><col style={{ width: 48 }} />{COLUMNS.map((column) => <col key={column.id} style={{ width: column.width }} />)}</colgroup>
              <thead className="sticky top-0 z-10 bg-muted"><tr aria-rowindex={1}>
                <th scope="col" className="h-9 border-b border-border px-4 sm:pl-6"><SelectionCheckbox label="Select all matching sandboxes" checked={allMatchingSelected} mixed={matchingSelected > 0 && !allMatchingSelected} disabled={deleting || !selectable.length} onChange={toggleMatching} /></th>
                {COLUMNS.map((column) => <th key={column.id} scope="col" aria-sort={sort.key === column.id ? sort.direction === "asc" ? "ascending" : "descending" : "none"} className="group/column h-9 border-b border-border px-4 text-left font-medium text-muted-foreground first:pl-6">
                  <div className="flex h-9 items-center gap-1">
                    <button onClick={() => setSort((current) => ({key: column.id, direction: current.key === column.id && current.direction === "asc" ? "desc" : "asc"}))} className="flex h-9 min-w-0 items-center gap-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring"><span className="truncate">{column.label}</span>{sort.key === column.id && (sort.direction === "asc" ? <ArrowUp className="size-3 shrink-0" /> : <ArrowDown className="size-3 shrink-0" />)}</button>
                    <ColumnMenu column={column} sort={sort} onSort={(direction) => setSort({ key: column.id, direction })} values={columnValues[column.id]} value={filters[column.id]} onFilter={(value) => setFilter(column.id, value)} />
                  </div>
                </th>)}
              </tr></thead>
              <tbody>
                {virtual.paddingTop > 0 && <tr aria-hidden="true"><td colSpan={8} style={{ height: virtual.paddingTop, padding: 0, border: 0 }} /></tr>}
                {ordered.slice(virtual.start, virtual.end).map((row, index) => <InventoryRow key={keyOf(row.sandbox)} row={row} now={now} index={virtual.start + index + 2} onOpen={setOpened} selected={selected.has(keyOf(row.sandbox))} onSelect={toggleSelected} disabled={deleting || live.demo || !row.sandbox.location?.connected} />)}
                {virtual.end < ordered.length && <tr aria-hidden="true"><td colSpan={8} style={{ height: (ordered.length - virtual.end) * ROW_HEIGHT, padding: 0, border: 0 }} /></tr>}
              </tbody>
            </table>}
        </div>
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border bg-card px-6 py-2 text-[11px] text-muted-foreground"><span><strong className="font-medium text-foreground">{number(ordered.length)}</strong>{filtering ? ` of ${number(sandboxes.length)}` : ""} sandboxes</span><span className="hidden sm:inline">Click a row to inspect · ⌘K to search</span></div>
      </div>
      {openedSandbox && openedLocation?.connected && <LocationProvider key={keyOf(openedSandbox)} location={openedLocation}><SandboxSheet name={openedSandbox.name} sandbox={openedSandbox} liveData={openedLive} onClose={() => setOpened(null)} onNavigate={onNavigate} onChanged={inventory.refresh} /></LocationProvider>}
      <AlertDialog open={deleteTargets !== null} onOpenChange={(open) => { if (!open && !deletionInFlight.current) setDeleteTargets(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {number(deleteTargets?.length ?? 0)} {deleteTargets?.length === 1 ? "sandbox" : "sandboxes"}?</AlertDialogTitle>
            <AlertDialogDescription>This permanently deletes the selected sandboxes and their data. This cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <ul aria-label="Sandboxes to delete" className="max-h-48 overflow-auto rounded-md border border-border p-3 text-xs">{deleteTargets?.map((sandbox) => <li key={keyOf(sandbox)} className="flex items-center gap-2 break-all py-1">{sandbox.name}<LocationBadge location={sandbox.location} /></li>)}</ul>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={deleting || !deleteTargets?.length} onClick={deleteSelected}>{deleting ? "Deleting…" : "Delete sandboxes"}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <LocationProvider location={chosenLocation}><CreateSandboxDialog open={creating} onOpenChange={setCreating} locations={locations} location={chosenLocation} onLocationChange={setCreationLocation} onRefreshLocations={inventory.refresh} allowRemote={canConnect} /></LocationProvider>
    </>
  )
}

const InventoryRow = React.memo(function InventoryRow({ row, now, index, onOpen, selected, onSelect, disabled }) {
  const { sandbox, owner, image } = row
  const cell = "h-10 border-b border-border/60 px-4 py-0 align-middle text-muted-foreground"
  const disconnected = !sandbox.location?.connected
  const label = `${sandbox.name} at ${locationLabel(sandbox.location)}`
  return <tr aria-rowindex={index} aria-disabled={disconnected || undefined} onClick={() => { if (!disconnected) onOpen(sandbox) }} className={`group transition-colors ${disconnected ? "opacity-60" : "cursor-pointer hover:bg-muted/60 focus-within:bg-muted/60"} ${selected ? "bg-accent/40" : "bg-card"}`}>
    <td className={`${cell} sm:pl-6`} onClick={(event) => event.stopPropagation()}><SelectionCheckbox label={`Select ${label}`} checked={selected} disabled={disabled} onChange={() => onSelect(sandbox)} /></td>
    <td className={`${cell} pl-6`}><button disabled={disconnected} aria-haspopup="dialog" aria-label={`Open ${label}`} onClick={(event) => { event.stopPropagation(); if (!disconnected) onOpen(sandbox) }} className="flex h-9 w-full min-w-0 items-center gap-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed"><Box aria-hidden="true" strokeWidth={1.4} className="size-3.5 shrink-0 text-muted-foreground" /><span className="truncate font-medium text-foreground" title={sandbox.name}>{sandbox.name}</span><ArrowUpRight className="ml-auto size-3 shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100" /></button></td>
    <td className={cell}><PlacementBadge location={sandbox.location} /></td>
    <td className={cell}><span className="flex items-center gap-1.5 whitespace-nowrap"><span className={`size-1.5 shrink-0 rounded-full ${styleOf(sandbox.phase).bar}`} />{PHASE_LABEL[sandbox.phase] ?? "Unknown"}</span></td>
    <td className={cell}><span className="block truncate" title={owner}>{owner}</span></td>
    <td className={cell}><span className="flex min-w-0 items-center gap-1.5" title={sandbox.image || image}><ImageMark /><span className="truncate font-mono text-[11px]">{image}</span></span></td>
    <td className={cell}><span className="block truncate font-mono text-[11px]" title="Uptime requires a reported start time">{uptimeOf(sandbox, now)}</span></td>
    <td className={cell}><span className="block truncate tabular-nums" title={sandbox.createdAt || "Not reported"}>{elapsedSince(sandbox.createdAt, now)}{sandbox.createdAt ? " ago" : ""}</span></td>
  </tr>
})

// Brings a disconnected SSH location back with the connect call the dialog
// uses. A host that needs Docker or runtime images is left to the dialog.
function LocationReconnect({ location, onReconnected }) {
  const api = useApi()
  const [state, setState] = React.useState({ busy: false, error: null })
  const mounted = React.useRef(true)
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  async function reconnect() {
    setState({ busy: true, error: null })
    try {
      let job = await api.connect({ host: location.host })
      while (job.status === "working") {
        await new Promise((resolve) => setTimeout(resolve, 1000))
        job = await api.connectionJob(job.id)
      }
      if (job.status !== "ready") throw new Error(job.error || `${location.host} needs setup. Use New sandbox → Remote to finish connecting.`)
      onReconnected()
      if (mounted.current) setState({ busy: false, error: null })
    } catch (reason) {
      if (mounted.current) setState({ busy: false, error: reason.message })
    }
  }
  return <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-amber-200 bg-amber-50 px-6 py-2 text-xs text-amber-800">
    <span>{locationLabel(location)} disconnected. Its last inventory is retained; reconnect to use these resources.{location.error ? ` ${location.error}` : ""}{state.error ? ` ${state.error}` : ""}</span>
    {location.host && <Button size="xs" variant="outline" disabled={state.busy} onClick={reconnect}><RefreshCw className={`size-3 ${state.busy ? "animate-spin motion-reduce:animate-none" : ""}`} />{state.busy ? "Reconnecting…" : "Reconnect"}</Button>}
  </div>
}

function SelectionCheckbox({ label, checked, mixed = false, disabled, onChange }) {
  const ref = React.useRef(null)
  React.useEffect(() => { if (ref.current) ref.current.indeterminate = mixed }, [mixed])
  return <input ref={ref} type="checkbox" aria-label={label} checked={checked} disabled={disabled} onChange={onChange} className="block size-4 cursor-pointer rounded border-border accent-[var(--action)] focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed" />
}

// Sort and filter for one inventory column. The trigger takes no room until
// the header is hovered, and stays while the column is filtered so a narrowed
// list never looks complete.
function ColumnMenu({ column, sort, onSort, values, value, onFilter }) {
  const active = column.filter === "values" ? value.length > 0 : column.filter === "recent" ? Boolean(value) : false
  const sorted = sort.key === column.id ? sort.direction : null
  const toggle = (item) => onFilter(value.includes(item) ? value.filter((entry) => entry !== item) : [...value, item])
  return <DropdownMenu>
    <DropdownMenuTrigger render={<button type="button" aria-label={`Sort and filter ${column.label}${active ? " (filtered)" : ""}`}
      className={`flex h-6 shrink-0 items-center justify-center overflow-hidden rounded outline-none hover:bg-background/70 hover:text-foreground focus-visible:w-6 focus-visible:ring-2 focus-visible:ring-ring data-[popup-open]:w-6 ${active ? "w-6 text-foreground" : "w-0 group-hover/column:w-6"}`} />}>
      <ListFilter className="size-3.5 shrink-0" />
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="w-56">
      <DropdownMenuGroup>
        <DropdownMenuItem className="text-xs" onClick={() => onSort("asc")}><ArrowUp className="size-3.5" />Sort ascending{sorted === "asc" && <Check className="ml-auto size-3.5" />}</DropdownMenuItem>
        <DropdownMenuItem className="text-xs" onClick={() => onSort("desc")}><ArrowDown className="size-3.5" />Sort descending{sorted === "desc" && <Check className="ml-auto size-3.5" />}</DropdownMenuItem>
      </DropdownMenuGroup>
      {column.filter === "values" && <>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel className="text-[11px]">Show only</DropdownMenuLabel>
          <div className="max-h-64 overflow-y-auto">
            {values.map((item) => <DropdownMenuCheckboxItem key={item.value} checked={value.includes(item.value)} onCheckedChange={() => toggle(item.value)} closeOnClick={false} className="text-xs">
              <span className="min-w-0 flex-1 truncate">{FILTER_ITEM[column.id]?.(item) ?? item.label}</span><span className="ml-2 font-mono text-[10px] tabular-nums text-muted-foreground">{number(item.count)}</span>
            </DropdownMenuCheckboxItem>)}
          </div>
        </DropdownMenuGroup>
      </>}
      {column.filter === "recent" && <>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel className="text-[11px]">Created</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={value} onValueChange={onFilter}>
            <DropdownMenuRadioItem value="" className="text-xs">Any time</DropdownMenuRadioItem>
            {RECENT.map((item) => <DropdownMenuRadioItem key={item.value} value={item.value} className="text-xs">{item.label}</DropdownMenuRadioItem>)}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </>}
      {active && <>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="text-xs" onClick={() => onFilter(column.filter === "values" ? [] : "")}><X className="size-3.5" />Clear filter</DropdownMenuItem>
      </>}
    </DropdownMenuContent>
  </DropdownMenu>
}
