import * as React from "react"
import { ArrowUpRight, ArrowUp, ArrowDown, Box, Cloud, Laptop, Check, Monitor, Plus, RefreshCw, Search, Trash2, X } from "lucide-react"
import { toast } from "sonner"
import { createApi } from "@/lib/api"
import { useCompute } from "@/lib/compute"
import { useInventory } from "@/lib/inventory"
import { LocationProvider, useApi, useLocation } from "@/lib/location-context"
import { locationLabel, resourceKey } from "@/lib/locations"
import { LocationBadge } from "@/components/location-badge"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { EgressChart, bucketEgress } from "@/components/egress-chart"
import { NumberTicker } from "@/components/ui/number-ticker"
import { SandboxSheet } from "@/components/sandbox-sheet"
import { CreateSandboxDialog } from "@/components/create-sandbox-dialog"
import { useVirtualRows } from "@/hooks/use-virtual-rows"
import { useDemoFleet } from "@/hooks/use-demo-fleet"
import { useLive } from "@/lib/live"
import { PHASE_LABEL, STATUS, elapsedSince, imageName, ownerOf, statusOf, styleOf, summarize, uptimeOf } from "@/lib/sandboxes"

export const BOX_HANDOFF = "gateway-box"
const EMPTY = []
const PREVIEW_LOCATION = { context: '["preview","default"]', gateway: "preview", workspace: "default", label: "Local", remote: false, connected: true }
const ROW_HEIGHT = 40
const FILTERS = ["all", "running", "sleeping", "provisioning", "error", "unknown"]
const locationKey = (location) => location?.id ?? location?.context
const keyOf = resourceKey
const nameKey = (sandbox) => JSON.stringify([locationKey(sandbox.location), sandbox.name])
const number = (value) => value.toLocaleString("en-US")
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })
const COLUMNS = [{ id: "name", label: "Sandbox", width: "28%" }, { id: "phase", label: "Status", width: "12%" }, { id: "owner", label: "Owner", width: "13%" }, { id: "image", label: "Image", width: "26%" }, { id: "startedAt", label: "Uptime", width: "10%" }, { id: "createdAt", label: "Created", width: "11%" }]

export function SandboxesView({ onNavigate, onConnect }) {
  const api = useApi()
  const compute = useCompute()
  const live = useDemoFleet(useLive())
  const inventory = useInventory()
  const { locations } = inventory
  const inheritedLocation = useLocation()
  const [selectedContext, setSelectedContext] = React.useState(null)
  const defaultContext = locationKey(inheritedLocation) ?? selectedContext
  const [locationFilter, setLocationFilter] = React.useState(locationKey(inheritedLocation) ?? "")
  const [creationLocation, setCreationLocation] = React.useState(null)
  const [handoff, setHandoff] = React.useState(null)
  const canConnect = Boolean(onConnect)
  React.useEffect(() => {
    let alive = true
    api.contextKey().then((context) => { if (alive) setSelectedContext(JSON.stringify([api.target, context])) }).catch(() => {})
    return () => { alive = false }
  }, [api])
  React.useEffect(() => { setLocationFilter(locationKey(inheritedLocation) ?? "") }, [locationKey(inheritedLocation)])
  const defaultLocation = locations.find((location) => locationKey(location) === defaultContext)
  const availableLocation = locations.find((location) => locationKey(location) === locationFilter && location.connected)
    ?? (defaultLocation?.connected ? defaultLocation : null)
    ?? locations.find((location) => location.target === api.target && !location.remote && location.connected)
    ?? locations.find((location) => location.target === api.target && location.connected)
  const chosenLocation = locations.find((location) => locationKey(location) === locationKey(creationLocation)) ?? creationLocation ?? availableLocation
  const [creations, setCreations] = React.useState([])
  const reportedSandboxes = React.useMemo(() => live.demo
    ? (live.sandboxes ?? EMPTY).map((sandbox) => ({ ...sandbox, location: defaultLocation ?? availableLocation ?? PREVIEW_LOCATION }))
    : inventory.sandboxes, [live.demo, live.sandboxes, defaultLocation, availableLocation, inventory.sandboxes])
  const sandboxes = React.useMemo(() => {
    const reported = new Set(reportedSandboxes.map(nameKey))
    return [...creations.filter((sandbox) => !sandbox.reported && !reported.has(nameKey(sandbox))).map((sandbox) => ({ ...sandbox, location: locations.find((location) => locationKey(location) === locationKey(sandbox.location)) ?? sandbox.location })), ...reportedSandboxes]
  }, [reportedSandboxes, creations, locations])
  const [query, setQuery] = React.useState("")
  const [status, setStatus] = React.useState("all")
  const [imageFilter, setImageFilter] = React.useState("")
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
    const receiveHandoff = (event) => {
      const value = event.detail
      if (typeof value?.name !== "string") return
      setHandoff({ name: value.name, context: value.location?.id ?? (value.context ? JSON.stringify([value.target ?? api.target, value.context]) : undefined) })
      inventory.refresh()
    }
    window.addEventListener("openrod-sandbox-handoff", receiveHandoff)
    try {
      const stored = sessionStorage.getItem(BOX_HANDOFF)
      sessionStorage.removeItem(BOX_HANDOFF)
      if (stored) {
        let value
        try { value = JSON.parse(stored) } catch { /* Legacy handoffs contain a plain name. */ }
        setHandoff(value && typeof value.name === "string" ? { name: value.name, context: locationKey(value.location) ?? (value.context && value.target ? JSON.stringify([value.target, value.context]) : value.context) } : { name: stored })
      }
    } catch { /* optional storage */ }
    return () => { clearInterval(timer); window.removeEventListener("keydown", onKey); window.removeEventListener("openrod-sandbox-handoff", receiveHandoff) }
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
  React.useEffect(() => {
    const names = new Set(reportedSandboxes.map(nameKey))
    setCreations((current) => {
      const next = current.filter((sandbox) => !sandbox.reported || names.has(nameKey(sandbox)))
        .map((sandbox) => !sandbox.reported && names.has(nameKey(sandbox)) ? { ...sandbox, reported: true } : sandbox)
      return next.length === current.length && next.every((sandbox, index) => sandbox === current[index]) ? current : next
    })
  }, [reportedSandboxes])
  function sandboxCreated(name, sandbox) {
    const created = { ...sandbox, name, location: sandbox?.location ?? chosenLocation, phase: sandbox?.phase || "provisioning" }
    setOpened(null)
    setCreations((current) => [...current.filter((item) => nameKey(item) !== nameKey(created)), created])
    setQuery(""); setStatus("all"); setImageFilter("")
    setLocationFilter(locationKey(created.location))
    setSort({ key: "createdAt", direction: "desc" })
    inventory.refresh()
  }
  const all = React.useMemo(() => summarize(sandboxes), [sandboxes])
  const indexed = React.useMemo(() => sandboxes.map((sandbox) => ({ sandbox, owner: ownerOf(sandbox), image: imageName(sandbox.image, sandbox.imageTemplateName), search: [sandbox.name, sandbox.id, sandbox.image, sandbox.imageTemplateName, locationLabel(sandbox.location), ownerOf(sandbox), ...(sandbox.providers ?? [])].join(" ").toLowerCase() })), [sandboxes])
  const images = React.useMemo(() => [...new Set(indexed.map((row) => row.image))].sort(collator.compare), [indexed])
  const ordered = React.useMemo(() => {
    const q = deferredQuery.trim().toLowerCase()
    const matched = indexed.filter((row) => (!locationFilter || locationKey(row.sandbox.location) === locationFilter) && (status === "all" || statusOf(row.sandbox.phase) === status) && (!imageFilter || row.image === imageFilter) && (!q || row.search.includes(q)))
    const value = (row) => sort.key === "owner" || sort.key === "image" ? row[sort.key] : sort.key === "startedAt" ? row.sandbox.phase === "ready" ? row.sandbox.startedAt : null : row.sandbox[sort.key]
    return matched.sort((a, b) => {
      const av = value(a), bv = value(b)
      if (!av && bv) return 1
      if (av && !bv) return -1
      const delta = collator.compare(av ?? "", bv ?? "")
      return (sort.direction === "asc" ? delta : -delta) || collator.compare(a.sandbox.name, b.sandbox.name)
    })
  }, [indexed, status, imageFilter, locationFilter, deferredQuery, sort])
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
  React.useEffect(() => { virtual.scrollToTop() }, [deferredQuery, status, imageFilter, locationFilter, sort])
  const points = React.useMemo(() => bucketEgress(live.events, 15, now), [live.events, now])
  const clearFilters = () => { setQuery(""); setStatus("all"); setImageFilter(""); setLocationFilter("") }
  const filtering = query || status !== "all" || imageFilter || locationFilter
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

  return (
    <>
      <div className="flex h-[calc(100svh-3.5rem)] min-h-0 flex-col overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 px-4 pt-4 pb-3 sm:px-6">
          <div className="flex flex-wrap gap-1" role="group" aria-label="Sandbox status">
            {FILTERS.filter((key) => ["all", "running", "sleeping"].includes(key) || all.status[key] > 0).map((key) => <button key={key} aria-pressed={status === key} onClick={() => { setStatus(key) }}
              className={`rounded-md px-3 py-1.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${status === key ? "bg-accent/70" : "hover:bg-muted/60"}`}>
              <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">{key !== "all" && <span aria-hidden="true" className={`size-1.5 rounded-full ${STATUS[key].bar}`} />}{key === "all" ? "Sandboxes" : STATUS[key].label}</span>
              <span className="mt-1 block font-mono text-lg leading-none tabular-nums"><NumberTicker value={key === "all" ? all.total : all.status[key]} /></span>
            </button>)}
          </div>
          <div className="ml-auto hidden w-64 px-3 lg:block"><EgressChart points={points} height={34} title="Connections · 15m" /></div>
        </div>
        <div className="flex h-[3px] shrink-0 overflow-hidden" role="img" aria-label={Object.entries(all.status).map(([key, value]) => `${value} ${STATUS[key].label}`).join(", ")}>
          {Object.entries(all.status).map(([key, value]) => value > 0 && <span key={key} className={STATUS[key].strip} style={{ width: `${value / all.total * 100}%` }} />)}
        </div>
        {inventory.error && sandboxes.length > 0 && <p role="alert" className="border-b border-amber-200 bg-amber-50 px-6 py-2 text-xs text-amber-800">Inventory refresh failed. Showing the last reading. {inventory.error}</p>}
        {locations.filter((location) => !location.connected).map((location) => <p key={locationKey(location)} role="status" className="border-b border-amber-200 bg-amber-50 px-6 py-2 text-xs text-amber-800">{locationLabel(location)} disconnected. Its last inventory is retained; reconnect to use these resources.{location.error ? ` ${location.error}` : ""}</p>)}
        {creations.map((created) => {
          const sandbox = sandboxes.find((item) => nameKey(item) === nameKey(created)) ?? created
          const ready = sandbox.phase === "ready"
          const ended = ["error", "stopped", "completed", "deleting"].includes(sandbox.phase)
          return <div key={nameKey(created)} role="status" aria-live="polite" className={`flex shrink-0 items-center gap-3 border-b border-border px-6 py-3 text-xs ${ended ? "bg-red-50 text-red-800" : ready ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-800"}`}>
            {ready ? <Check aria-hidden="true" className="size-4 shrink-0" /> : ended ? <Box aria-hidden="true" className="size-4 shrink-0" /> : <Spinner aria-hidden="true" className="size-4 shrink-0" />}
            <div className="min-w-0 flex-1"><p className="break-words font-medium">{ready ? `${created.name} is ready` : ended ? `${created.name} needs attention` : `Preparing ${created.name}…`}</p><p className="mt-0.5 opacity-80">{ready ? "Your sandbox is ready to use." : ended ? `Status: ${PHASE_LABEL[sandbox.phase]}. Open the sandbox to inspect it.` : "Your new sandbox is starting. You can keep browsing while it gets ready."}</p></div>
            <LocationBadge location={sandbox.location} />
            {(ready || ended) && <><Button variant="ghost" size="sm" disabled={!sandbox.location?.connected} onClick={() => setOpened(sandbox)}>Open sandbox<ArrowUpRight className="size-3" /></Button><Button variant="ghost" size="icon-sm" aria-label={`Dismiss status for ${created.name}`} onClick={() => setCreations((current) => current.filter((item) => nameKey(item) !== nameKey(created)))}><X className="size-3.5" /></Button></>}
          </div>
        })}
        {live.demo && <p className="border-b border-border px-6 py-2 text-xs text-amber-700">Preview · synthetic sandbox data</p>}
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2 sm:px-6">
          <div className="relative mr-auto w-full sm:w-64"><Search aria-hidden="true" className="absolute top-2.5 left-3 size-3.5 text-muted-foreground" />
            <Input ref={search} value={query} onChange={(e) => { setQuery(e.target.value) }} placeholder="Search name, owner, image…" aria-label="Search sandboxes" className="h-9 pl-9 pr-8 text-xs" />
            {query && <button aria-label="Clear search" className="absolute top-2.5 right-2" onClick={() => setQuery("")}><X className="size-4" /></button>}
          </div>
          <Select value={locationFilter} onValueChange={(value) => setLocationFilter(value ?? "")} items={[{ value: "", label: "All locations" }, ...locations.map((location) => ({ value: locationKey(location), label: locationLabel(location) }))]}>
            <SelectTrigger aria-label="Filter by location" className="h-8 w-44 bg-card text-xs"><SelectValue className="min-w-0 truncate" /></SelectTrigger>
            <SelectContent align="end" alignItemWithTrigger={false}>
              <SelectGroup>
                <SelectItem value="" className="text-xs">All locations</SelectItem>
                {locations.map((location) => <SelectItem key={locationKey(location)} value={locationKey(location)} className="text-xs">{locationLabel(location)}{!location.connected ? " · Disconnected" : ""}</SelectItem>)}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Select value={imageFilter} onValueChange={(value) => setImageFilter(value ?? "")} items={[{ value: "", label: "All images" }, ...images.map((image) => ({ value: image, label: image }))]}>
            <SelectTrigger aria-label="Filter by image" className="h-8 w-44 bg-card text-xs">
              <SelectValue className="min-w-0 truncate" />
            </SelectTrigger>
            <SelectContent align="end" alignItemWithTrigger={false} className="w-max min-w-44 max-w-[min(24rem,calc(100vw-2rem))]">
              <SelectGroup>
                <SelectItem value="" className="text-xs">All images</SelectItem>
                {images.map((image) => <SelectItem key={image} value={image} className="text-xs [&_[data-slot=select-item-text]]:truncate">{image}</SelectItem>)}
              </SelectGroup>
            </SelectContent>
          </Select>
          {filtering && <Button variant="ghost" size="sm" onClick={clearFilters}><X className="size-3" />Clear</Button>}
          <Button variant="ghost" size="icon-sm" aria-label="Refresh sandboxes" onClick={inventory.refresh}><RefreshCw className="size-3.5" /></Button>
          {canConnect && <Button variant="outline" size="sm" onClick={onConnect}><Monitor aria-hidden="true" className="size-3.5" />Connect machine</Button>}
          <Button size="sm" disabled={!availableLocation} onClick={beginCreation} className="bg-[var(--action)] text-[var(--action-foreground)] hover:bg-[var(--action)]/90"><Plus className="size-3.5" />New sandbox</Button>
        </div>
        {selectedBoxes.length > 0 && <div className="flex flex-wrap items-center gap-3 border-b border-border bg-accent/30 px-6 py-2">
          <span role="status" className="mr-auto text-xs"><strong>{number(selectedBoxes.length)}</strong> selected{selectedBoxes.length > matchingSelected && <span className="text-muted-foreground"> · {number(selectedBoxes.length - matchingSelected)} outside current filters</span>}</span>
          <Button variant="ghost" size="sm" disabled={deleting} onClick={() => setSelected(new Set())}>Clear selection</Button>
          <Button variant="destructive" size="sm" disabled={deleting || live.demo} title={live.demo ? "Deletion is unavailable for synthetic preview data" : undefined} onClick={() => setDeleteTargets([...selectedBoxes])}><Trash2 className="size-3.5" />{deleting ? "Deleting…" : "Delete selected"}</Button>
        </div>}
        {deleteErrors.length > 0 && <div role="alert" className="border-b border-border px-6 py-2 text-xs text-destructive">
          <div className="flex items-center justify-between gap-2"><p>Some sandboxes could not be deleted. Failed boxes remain selected for retry.</p><Button variant="ghost" size="icon-sm" aria-label="Dismiss deletion errors" onClick={() => setDeleteErrors([])}><X className="size-3.5" /></Button></div>
          <ul className="max-h-28 overflow-auto">{deleteErrors.map((error) => <li key={error.key}><strong>{error.name}</strong> <LocationBadge location={error.location} />: {error.message}</li>)}</ul>
        </div>}
        <div ref={virtual.ref} onScroll={virtual.onScroll} tabIndex={0} role="region" aria-label="Sandbox inventory" className="min-h-0 flex-1 overflow-auto overscroll-contain outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
          {loading ? <p role="status" className="py-20 text-center text-sm text-muted-foreground">Loading sandboxes…</p>
            : unreachable ? <div role="alert" className="py-16 text-center"><p>Inventory unavailable</p><p className="mt-2 text-sm text-muted-foreground">{inventory.error}</p><Button variant="outline" onClick={inventory.refresh} className="mt-4">Retry</Button></div>
            : !ordered.length ? <div className="py-20 text-center"><Box className="mx-auto mb-3 size-6 text-muted-foreground" /><p className="text-sm">{sandboxes.length ? "No matching sandboxes" : "No sandboxes yet"}</p><Button variant="outline" disabled={!sandboxes.length && !availableLocation} className="mt-4" onClick={() => sandboxes.length ? clearFilters() : beginCreation()}>{sandboxes.length ? "Clear filters" : "Create sandbox"}</Button></div>
            : <table aria-label="Sandboxes" aria-rowcount={ordered.length + 1} className="w-full min-w-[1040px] table-fixed border-separate border-spacing-0 text-xs">
              <colgroup><col style={{ width: 48 }} />{COLUMNS.map((column) => <col key={column.id} style={{ width: column.width }} />)}</colgroup>
              <thead className="sticky top-0 z-10 bg-muted"><tr aria-rowindex={1}>
                <th scope="col" className="h-9 border-b border-border px-4"><SelectionCheckbox label="Select all matching sandboxes" checked={allMatchingSelected} mixed={matchingSelected > 0 && !allMatchingSelected} disabled={deleting || !selectable.length} onChange={toggleMatching} /></th>
                {COLUMNS.map((column) => <th key={column.id} scope="col" aria-sort={sort.key === column.id ? sort.direction === "asc" ? "ascending" : "descending" : "none"} className="h-9 border-b border-border px-4 text-left font-medium text-muted-foreground first:pl-6">
                  <button onClick={() => setSort((current) => ({key: column.id, direction: current.key === column.id && current.direction === "asc" ? "desc" : "asc"}))} className="flex h-9 w-full items-center gap-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring">{column.label}{sort.key === column.id && (sort.direction === "asc" ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}</button>
                </th>)}
              </tr></thead>
              <tbody>
                {virtual.paddingTop > 0 && <tr aria-hidden="true"><td colSpan={7} style={{ height: virtual.paddingTop, padding: 0, border: 0 }} /></tr>}
                {ordered.slice(virtual.start, virtual.end).map((row, index) => <InventoryRow key={keyOf(row.sandbox)} row={row} now={now} index={virtual.start + index + 2} onOpen={setOpened} selected={selected.has(keyOf(row.sandbox))} onSelect={toggleSelected} disabled={deleting || live.demo || !row.sandbox.location?.connected} />)}
                {virtual.end < ordered.length && <tr aria-hidden="true"><td colSpan={7} style={{ height: (ordered.length - virtual.end) * ROW_HEIGHT, padding: 0, border: 0 }} /></tr>}
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
      <LocationProvider location={chosenLocation}><CreateSandboxDialog open={creating} onOpenChange={setCreating} onCreated={sandboxCreated} locations={locations} location={chosenLocation} onLocationChange={setCreationLocation} /></LocationProvider>
    </>
  )
}

const InventoryRow = React.memo(function InventoryRow({ row, now, index, onOpen, selected, onSelect, disabled }) {
  const { sandbox, owner, image } = row
  const cell = "h-10 border-b border-border/60 px-4 py-0 align-middle text-muted-foreground"
  const disconnected = !sandbox.location?.connected
  const label = `${sandbox.name} at ${locationLabel(sandbox.location)}`
  return <tr aria-rowindex={index} aria-disabled={disconnected || undefined} onClick={() => { if (!disconnected) onOpen(sandbox) }} className={`group transition-colors ${disconnected ? "opacity-60" : "cursor-pointer hover:bg-muted/60 focus-within:bg-muted/60"} ${selected ? "bg-accent/40" : "bg-card"}`}>
    <td className={cell} onClick={(event) => event.stopPropagation()}><SelectionCheckbox label={`Select ${label}`} checked={selected} disabled={disabled} onChange={() => onSelect(sandbox)} /></td>
    <td className={`${cell} pl-6`}><button disabled={disconnected} aria-haspopup="dialog" aria-label={`Open ${label}`} onClick={(event) => { event.stopPropagation(); if (!disconnected) onOpen(sandbox) }} className="flex h-9 w-full min-w-0 items-center gap-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed"><LocationIcon location={sandbox.location} /><span className="truncate font-medium text-foreground" title={sandbox.name}>{sandbox.name}</span><LocationBadge location={sandbox.location} /><ArrowUpRight className="ml-auto size-3 shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100" /></button></td>
    <td className={cell}><span className="flex items-center gap-1.5 whitespace-nowrap"><span className={`size-1.5 shrink-0 rounded-full ${styleOf(sandbox.phase).bar}`} />{PHASE_LABEL[sandbox.phase] ?? "Unknown"}</span></td>
    <td className={cell}><span className="block truncate" title={owner}>{owner}</span></td>
    <td className={cell}><span className="block truncate font-mono text-[11px]" title={sandbox.image || image}>{image}</span></td>
    <td className={cell}><span className="block truncate font-mono text-[11px]" title="Uptime requires a reported start time">{uptimeOf(sandbox, now)}</span></td>
    <td className={cell}><span className="block truncate tabular-nums" title={sandbox.createdAt || "Not reported"}>{elapsedSince(sandbox.createdAt, now)}{sandbox.createdAt ? " ago" : ""}</span></td>
  </tr>
})

function LocationIcon({ location }) {
  const cloud = location?.cloud || location?.target === "cloud"
  const Icon = cloud ? Cloud : location?.remote ? Monitor : Laptop
  const label = cloud ? "Cloud compute" : location?.remote ? "SSH machine" : "Local compute"
  return <span role="img" aria-label={label} title={label}><Icon aria-hidden="true" strokeWidth={1.4} className="size-3.5 shrink-0 text-muted-foreground" /></span>
}

function SelectionCheckbox({ label, checked, mixed = false, disabled, onChange }) {
  const ref = React.useRef(null)
  React.useEffect(() => { if (ref.current) ref.current.indeterminate = mixed }, [mixed])
  return <input ref={ref} type="checkbox" aria-label={label} checked={checked} disabled={disabled} onChange={onChange} className="block size-4 cursor-pointer rounded border-border accent-[var(--action)] focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed" />
}
