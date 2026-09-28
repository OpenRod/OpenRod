import * as React from "react"
import { ArrowUpRight, ArrowUp, ArrowDown, Box, Plus, RefreshCw, Search, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
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
const ROW_HEIGHT = 40
const FILTERS = ["all", "running", "sleeping", "provisioning", "error", "unknown"]
const groupOf = (sandbox) => sandbox.labels?.["openshell.console/group"] || "No group"
const number = (value) => value.toLocaleString("en-US")
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })
const COLUMNS = [{ id: "name", label: "Sandbox", width: "22%" }, { id: "phase", label: "Status", width: "12%" }, { id: "owner", label: "Owner", width: "13%" }, { id: "image", label: "Image", width: "19%" }, { id: "group", label: "Group", width: "13%" }, { id: "startedAt", label: "Uptime", width: "10%" }, { id: "createdAt", label: "Created", width: "11%" }]

export function SandboxesView({ onNavigate }) {
  const live = useDemoFleet(useLive())
  const sandboxes = live.sandboxes ?? EMPTY
  const [query, setQuery] = React.useState("")
  const [status, setStatus] = React.useState("all")
  const [imageFilter, setImageFilter] = React.useState("")
  const [groupFilter, setGroupFilter] = React.useState("")
  const [sort, setSort] = React.useState({ key: "name", direction: "asc" })
  const deferredQuery = React.useDeferredValue(query)
  const [opened, setOpened] = React.useState(null)
  const [creating, setCreating] = React.useState(false)
  const [now, setNow] = React.useState(Date.now)
  const search = React.useRef(null)
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000)
    const onKey = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); search.current?.focus() }
    }
    window.addEventListener("keydown", onKey)
    try { const name = sessionStorage.getItem(BOX_HANDOFF); sessionStorage.removeItem(BOX_HANDOFF); if (name) setOpened(name) } catch { /* optional storage */ }
    return () => { clearInterval(timer); window.removeEventListener("keydown", onKey) }
  }, [])
  const all = React.useMemo(() => summarize(sandboxes), [sandboxes])
  const indexed = React.useMemo(() => sandboxes.map((sandbox) => ({ sandbox, owner: ownerOf(sandbox), group: groupOf(sandbox), image: imageName(sandbox.image), search: [sandbox.name, sandbox.id, sandbox.image, ownerOf(sandbox), groupOf(sandbox), ...(sandbox.providers ?? [])].join(" ").toLowerCase() })), [sandboxes])
  const images = React.useMemo(() => [...new Set(indexed.map((row) => row.image))].sort(collator.compare), [indexed])
  const groups = React.useMemo(() => [...new Set(indexed.map((row) => row.group))].sort(collator.compare), [indexed])
  const ordered = React.useMemo(() => {
    const q = deferredQuery.trim().toLowerCase()
    const matched = indexed.filter((row) => (status === "all" || statusOf(row.sandbox.phase) === status) && (!imageFilter || row.image === imageFilter) && (!groupFilter || row.group === groupFilter) && (!q || row.search.includes(q)))
    const value = (row) => sort.key === "owner" || sort.key === "image" || sort.key === "group" ? row[sort.key] : sort.key === "startedAt" ? row.sandbox.phase === "ready" ? row.sandbox.startedAt : null : row.sandbox[sort.key]
    return matched.sort((a, b) => {
      const av = value(a), bv = value(b)
      if (!av && bv) return 1
      if (av && !bv) return -1
      const delta = collator.compare(av ?? "", bv ?? "")
      return (sort.direction === "asc" ? delta : -delta) || collator.compare(a.sandbox.name, b.sandbox.name)
    })
  }, [indexed, status, imageFilter, groupFilter, deferredQuery, sort])
  const virtual = useVirtualRows({ count: ordered.length, rowHeight: ROW_HEIGHT })
  React.useEffect(() => { virtual.scrollToTop() }, [deferredQuery, status, imageFilter, groupFilter, sort])
  const points = React.useMemo(() => bucketEgress(live.events, 15, now), [live.events, now])
  const pending = React.useMemo(() => {
    const result = new Map()
    for (const item of live.approvals.pending) result.set(item.sandbox, (result.get(item.sandbox) ?? 0) + 1)
    return result
  }, [live.approvals.pending])
  const clearFilters = () => { setQuery(""); setStatus("all"); setImageFilter(""); setGroupFilter("") }
  const filtering = query || status !== "all" || imageFilter || groupFilter
  const loading = live.sandboxes === null && !live.overview?.error
  const unreachable = live.sandboxes === null && live.overview?.error

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
        {live.connection === "gateway-down" && sandboxes.length > 0 && <p role="alert" className="border-b border-amber-200 bg-amber-50 px-6 py-2 text-xs text-amber-800">Gateway unreachable. Showing the last reading.</p>}
        {live.demo && <p className="border-b border-border px-6 py-2 text-xs text-amber-700">Preview · synthetic sandbox data</p>}
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2 sm:px-6">
          <div className="relative mr-auto w-full sm:w-64"><Search aria-hidden="true" className="absolute top-2.5 left-3 size-3.5 text-muted-foreground" />
            <Input ref={search} value={query} onChange={(e) => { setQuery(e.target.value) }} placeholder="Search name, owner, image…" aria-label="Search sandboxes" className="h-9 pl-9 pr-8 text-xs" />
            {query && <button aria-label="Clear search" className="absolute top-2.5 right-2" onClick={() => setQuery("")}><X className="size-4" /></button>}
          </div>
          <select aria-label="Filter by image" value={imageFilter} onChange={(e) => setImageFilter(e.target.value)} className="h-8 max-w-44 rounded-md border border-border bg-card px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"><option value="">All images</option>{images.map((image) => <option key={image}>{image}</option>)}</select>
          <select aria-label="Filter by group" value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)} className="h-8 max-w-40 rounded-md border border-border bg-card px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"><option value="">All groups</option>{groups.map((group) => <option key={group}>{group}</option>)}</select>
          {filtering && <Button variant="ghost" size="sm" onClick={clearFilters}><X className="size-3" />Clear</Button>}
          <Button variant="ghost" size="icon-sm" aria-label="Refresh sandboxes" onClick={live.refresh}><RefreshCw className="size-3.5" /></Button>
          <Button size="sm" onClick={() => setCreating(true)} className="bg-[var(--action)] text-white hover:bg-[var(--action)]/90"><Plus className="size-3.5" />New sandbox</Button>
        </div>
        <div ref={virtual.ref} onScroll={virtual.onScroll} tabIndex={0} role="region" aria-label="Sandbox inventory" className="min-h-0 flex-1 overflow-auto overscroll-contain outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
          {loading ? <p role="status" className="py-20 text-center text-sm text-muted-foreground">Loading sandboxes…</p>
            : unreachable ? <div role="alert" className="py-16 text-center"><p>Gateway unreachable</p><p className="mt-2 text-sm text-muted-foreground">{live.overview.error}</p><Button variant="outline" onClick={live.refresh} className="mt-4">Retry</Button></div>
            : !ordered.length ? <div className="py-20 text-center"><Box className="mx-auto mb-3 size-6 text-muted-foreground" /><p className="text-sm">{sandboxes.length ? "No matching sandboxes" : "No sandboxes yet"}</p><Button variant="outline" className="mt-4" onClick={() => sandboxes.length ? clearFilters() : setCreating(true)}>{sandboxes.length ? "Clear filters" : "Create sandbox"}</Button></div>
            : <table aria-label="Sandboxes" aria-rowcount={ordered.length + 1} className="w-full min-w-[1040px] table-fixed border-separate border-spacing-0 text-xs">
              <colgroup>{COLUMNS.map((column) => <col key={column.id} style={{ width: column.width }} />)}</colgroup>
              <thead className="sticky top-0 z-10 bg-muted"><tr aria-rowindex={1}>
                {COLUMNS.map((column) => <th key={column.id} scope="col" aria-sort={sort.key === column.id ? sort.direction === "asc" ? "ascending" : "descending" : "none"} className="h-9 border-b border-border px-4 text-left font-medium text-muted-foreground first:pl-6">
                  <button onClick={() => setSort((current) => ({key: column.id, direction: current.key === column.id && current.direction === "asc" ? "desc" : "asc"}))} className="flex h-9 w-full items-center gap-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring">{column.label}{sort.key === column.id && (sort.direction === "asc" ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}</button>
                </th>)}
              </tr></thead>
              <tbody>
                {virtual.paddingTop > 0 && <tr aria-hidden="true"><td colSpan={7} style={{ height: virtual.paddingTop, padding: 0, border: 0 }} /></tr>}
                {ordered.slice(virtual.start, virtual.end).map((row, index) => <InventoryRow key={row.sandbox.id ?? row.sandbox.name} row={row} now={now} pending={pending.get(row.sandbox.name) ?? 0} index={virtual.start + index + 2} onOpen={setOpened} />)}
                {virtual.end < ordered.length && <tr aria-hidden="true"><td colSpan={7} style={{ height: (ordered.length - virtual.end) * ROW_HEIGHT, padding: 0, border: 0 }} /></tr>}
              </tbody>
            </table>}
        </div>
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border bg-card px-6 py-2 text-[11px] text-muted-foreground"><span><strong className="font-medium text-foreground">{number(ordered.length)}</strong>{filtering ? ` of ${number(sandboxes.length)}` : ""} sandboxes</span><span className="hidden sm:inline">Click a row to inspect · ⌘K to search</span></div>
      </div>
      <SandboxSheet key={opened ?? "closed"} name={opened} liveData={live} onClose={() => setOpened(null)} onNavigate={onNavigate} />
      <CreateSandboxDialog open={creating} onOpenChange={setCreating} onCreated={setOpened} />
    </>
  )
}

const InventoryRow = React.memo(function InventoryRow({ row, now, pending, index, onOpen }) {
  const { sandbox, owner, image, group } = row
  const cell = "h-10 border-b border-border/60 px-4 py-0 align-middle text-muted-foreground"
  return <tr aria-rowindex={index} onClick={() => onOpen(sandbox.name)} className="group cursor-pointer bg-card transition-colors hover:bg-muted/60 focus-within:bg-muted/60">
    <td className={`${cell} pl-6`}><button aria-haspopup="dialog" aria-label={`Open ${sandbox.name}`} onClick={(event) => { event.stopPropagation(); onOpen(sandbox.name) }} className="flex h-9 w-full min-w-0 items-center gap-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"><Box aria-hidden="true" strokeWidth={1.4} className="size-3.5 shrink-0 text-muted-foreground" /><span className="truncate font-medium text-foreground" title={sandbox.name}>{sandbox.name}</span>{pending > 0 && <span className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-800" title={`${pending} pending approvals`}>{pending}</span>}<ArrowUpRight className="ml-auto size-3 shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100" /></button></td>
    <td className={cell}><span className="flex items-center gap-1.5 whitespace-nowrap"><span className={`size-1.5 shrink-0 rounded-full ${styleOf(sandbox.phase).bar}`} />{PHASE_LABEL[sandbox.phase] ?? "Unknown"}</span></td>
    <td className={cell}><span className="block truncate" title={owner}>{owner}</span></td>
    <td className={cell}><span className="block truncate font-mono text-[11px]" title={image}>{image}</span></td>
    <td className={cell}><span className="block truncate" title={group}>{group}</span></td>
    <td className={cell}><span className="block truncate font-mono text-[11px]" title="Uptime requires a reported start time">{uptimeOf(sandbox, now)}</span></td>
    <td className={cell}><span className="block truncate tabular-nums" title={sandbox.createdAt || "Not reported"}>{elapsedSince(sandbox.createdAt, now)}{sandbox.createdAt ? " ago" : ""}</span></td>
  </tr>
})
