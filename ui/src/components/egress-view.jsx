import * as React from "react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import {
  AlertTriangle, ArrowLeft, ArrowUpRight, Box, Building2, ChevronDown, ChevronRight, FolderLock, Globe2, KeyRound, Network, Plus, RefreshCw, RotateCcw, Search, ShieldCheck, ShieldOff, Trash2, Users, X,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { NumberTicker } from "@/components/ui/number-ticker"
import { EgressChart, bucketEgress } from "@/components/egress-chart"
import { Notice } from "@/components/notice"
import { Input } from "@/components/ui/input"
import { SearchInput } from "@/components/ui/search-input"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { RuleEditor } from "@/components/rule-editor"
import { BlockedHostsDialog, PolicyDialog, appliesTo, appliesToText, blockPatterns, newPolicy } from "@/components/egress-policies"
import { HostTile } from "@/components/perimeter"
import { useApi, useLocation } from "@/lib/location-context"
import { deleteNetworkPolicies } from "@/lib/delete-network-policies"
import { useLive } from "@/lib/live"
import { relativeTime, absoluteTime } from "@/lib/format"
import { styleOf } from "@/lib/sandboxes"
import { groupFor } from "@/lib/groups"
import { hostMatches } from "@/lib/egress"
import { SOURCE, SOURCE_ORDER, displayName, hostOf, isIp, portOf, program, sourceOf } from "@/lib/policy-sources"
import { cn } from "@/lib/utils"
import { SelectField } from '@/components/ui/select-field'

const REVISION = {
  loaded: { label: "Enforced", dot: "bg-emerald-500", cls: "bg-emerald-50 text-emerald-800 border-emerald-600/20" },
  pending: { label: "Loading", dot: "bg-amber-400", cls: "bg-amber-50 text-amber-800 border-amber-500/30" },
  failed: { label: "Failed", dot: "bg-red-500", cls: "bg-red-50 text-red-700 border-red-200" },
  superseded: { label: "Superseded", dot: "bg-stone-300", cls: "bg-muted text-muted-foreground border-border" },
  unspecified: { label: "Unknown", dot: "bg-stone-200", cls: "bg-muted text-muted-foreground border-border" },
}
const ACCESS_LABEL = { "read-only": "Read only", "read-write": "Read & write", full: "Any request", custom: "Specific requests", connect: "Connection", none: "No access", blocked: "Blocked" }
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "*"]
const ICON = { own: Globe2, agent: Box, org: Building2, group: Users, policy: ShieldCheck, secret: KeyRound }
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`
const slug = (host) => host.replace(/^\*\*?\./, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 56)

function Chip({ children, tone = "", title }) {
  return <span title={title} className={cn("rounded-md border px-1.5 py-px font-mono text-[10.5px]", tone || "border-border text-muted-foreground")}>{children}</span>
}

function SourcePill({ source }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2 py-0.5 text-[11.5px] text-foreground/80">
      <span className={cn("size-1.5 rounded-full", SOURCE[source].swatch)} aria-hidden="true" />{SOURCE[source].label}
    </span>
  )
}

function Card({ className, children }) {
  return <div className={cn("rounded-lg border border-border bg-card", className)}>{children}</div>
}

function Segmented({ options, value, onChange, label }) {
  return (
    <div role="tablist" aria-label={label} className="flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
      {options.map((o) => (
        <button key={o.id} role="tab" aria-selected={value === o.id} onClick={() => onChange(o.id)}
          className={cn("rounded-md px-2.5 py-1 text-[12px] outline-none transition-all focus-visible:ring-2 focus-visible:ring-ring",
            value === o.id ? "bg-card text-foreground shadow-[0_1px_2px_#0000001a]" : "text-muted-foreground hover:text-foreground")}>
          {o.label}{o.count != null && <span className="ml-1 text-faint tabular-nums">{o.count}</span>}
        </button>
      ))}
    </div>
  )
}

function Coverage({ n, total }) {
  return (
    <span className="flex items-center gap-2.5">
      <span className="h-1 w-14 overflow-hidden rounded-full bg-muted"><span className="block h-full rounded-full bg-stone-700" style={{ width: `${total ? (n / total) * 100 : 0}%` }} /></span>
      <span className="text-[12px] tabular-nums"><span className="text-foreground">{n}</span><span className="text-faint">/{total}</span></span>
    </span>
  )
}

const DEST_COLS = "grid-cols-[minmax(0,2fr)_minmax(0,1fr)_8rem_7rem_5rem_1rem]"
const BLOCK_COLS = "grid-cols-[minmax(0,1.6fr)_7.5rem_5rem_minmax(0,1fr)_13.5rem]"
const BOX_COLS = "grid-cols-[minmax(0,1.2fr)_minmax(0,1.3fr)_8rem_5rem_1rem]"
const POLICY_COLS = "grid-cols-[1rem_minmax(0,1.1fr)_4.5rem_minmax(0,1.5fr)_minmax(0,1fr)_7.5rem_5rem]"

function DestinationRow({ d, total, onOpen }) {
  const [open, setOpen] = React.useState(false)
  const reduceMotion = useReducedMotion()
  const detailsId = React.useId()
  const sources = SOURCE_ORDER.filter((s) => d.sources.has(s))
  const grants = [...d.grants].sort((a, b) => a.sandbox.localeCompare(b.sandbox) || a.key.localeCompare(b.key))
  return (
    <li>
      <button onClick={() => setOpen(!open)} aria-expanded={open} aria-controls={detailsId}
        className={cn("grid min-h-10 w-full items-center gap-4 px-6 py-2 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:bg-muted/60", open && "bg-muted/60", DEST_COLS)}>
        <span className="flex min-w-0 items-center gap-3">
          <HostTile host={d.host} className="size-6 text-[13px]" />
          <span className="min-w-0">
            <span className="block truncate font-mono text-[11px]" title={d.host}>{d.host}<span className="ml-2 text-faint">{[...d.ports].map((p) => `:${p}`).join(" ")}</span></span>
          </span>
        </span>
        <span className="flex flex-wrap gap-1">{sources.map((s) => <SourcePill key={s} source={s} />)}</span>
        <span className="text-[12px] text-muted-foreground">{d.access.size === 1 ? ACCESS_LABEL[[...d.access][0]] ?? [...d.access][0] : "Mixed"}</span>
        <span className="block"><Coverage n={d.sandboxes.size} total={total} /></span>
        <span className="text-right text-[12px] tabular-nums text-muted-foreground">{d.hits ? d.hits.toLocaleString() : "-"}</span>
        <ChevronRight className={cn("size-3.5 text-faint transition-transform", open && "rotate-90")} aria-hidden="true" />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div id={detailsId} role="region" aria-label={`Access to ${d.host}`}
            initial={reduceMotion ? false : { height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }} transition={{ duration: reduceMotion ? 0 : 0.18, ease: [0.2, 0, 0, 1] }} className="overflow-hidden bg-muted/30">
            <motion.div initial={reduceMotion ? false : { opacity: 0, y: -3 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: reduceMotion ? 0 : 0.2 }} className="px-6 pt-3 pb-4 pl-[3.75rem]">
              <div className="mb-2 flex items-baseline gap-2">
                <h3 className="text-xs font-medium">Sandbox access</h3>
                <span className="text-[11px] text-muted-foreground">{plural(d.sandboxes.size, "sandbox", "sandboxes")} · {plural(grants.length, "rule assignment")}</span>
              </div>
              <div className="overflow-hidden rounded-md border border-border bg-card">
                <table className="w-full table-fixed text-left text-xs" aria-label={`Sandbox access to ${d.host}`}>
                  <colgroup><col className="w-[35%]" /><col className="w-[35%]" /><col className="w-[15%]" /><col className="w-[15%]" /></colgroup>
                  <thead className="border-b border-border bg-muted/40 text-[11px] text-muted-foreground">
                    <tr>{["Sandbox", "Rule", "Source"].map((label) => <th key={label} scope="col" className="h-8 px-3 font-medium">{label}</th>)}<th scope="col" className="px-3"><span className="sr-only">Actions</span></th></tr>
                  </thead>
                  <tbody className="divide-y divide-border/60">
                    {grants.map((grant) => {
                      const source = SOURCE[sourceOf(grant.key)]
                      return <tr key={`${grant.sandbox}:${grant.key}`} className="transition-colors hover:bg-muted/30 focus-within:bg-muted/30">
                        <td className="h-10 px-3"><span className="flex min-w-0 items-center gap-2"><Box aria-hidden="true" strokeWidth={1.4} className="size-3.5 shrink-0 text-muted-foreground" /><span className="truncate font-medium" title={grant.sandbox}>{grant.sandbox}</span></span></td>
                        <td className="px-3"><span className="block truncate font-mono text-[11px] text-muted-foreground" title={displayName(grant.key)}>{displayName(grant.key)}</span></td>
                        <td className="px-3 text-muted-foreground"><span className="flex items-center gap-1.5"><span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", source.swatch)} />{source.label}</span></td>
                        <td className="px-2 text-right"><Button variant="ghost" size="sm" className="h-7 text-[11px] text-muted-foreground" aria-label={`View ${grant.sandbox} policy for ${displayName(grant.key)}`} onClick={() => onOpen(grant.sandbox)}>View rules<ArrowUpRight className="size-3" /></Button></td>
                      </tr>
                    })}
                  </tbody>
                </table>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </li>
  )
}

function BlockedRow({ b, onDecide }) {
  return (
    <li className={cn("grid items-center gap-4 px-6 py-2", BLOCK_COLS)}>
      <span className="flex min-w-0 items-center gap-3">
        <HostTile host={b.host} tone="denied" className="size-6 text-[13px]" />
        <span className="min-w-0">
          <span className="block truncate font-mono text-xs">{b.host}</span>
          <span className="block text-[11.5px] text-muted-foreground">:{b.port}{b.lastAt ? ` · ${relativeTime(b.lastAt)}` : ""}</span>
        </span>
      </span>
      <span className="text-[12px] tabular-nums">{plural(b.sandboxes.size, "sandbox", "sandboxes")}</span>
      <span className="text-[12px] tabular-nums text-red-600/90">{b.attempts}×</span>
      <span className="truncate font-mono text-[11.5px] text-muted-foreground">{[...b.programs].map(program).join(", ") || "-"}</span>
      <span className="flex items-center justify-end gap-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger className="inline-flex h-7 items-center gap-1 rounded-md bg-[var(--action)] px-2.5 text-[12px] font-medium text-[var(--action-foreground)] outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring">
            Allow<ChevronDown className="size-3 opacity-70" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Allow {b.host}</DropdownMenuLabel>
              <DropdownMenuItem onClick={() => onDecide("allow-org", b)}>
                <Users />Choose groups<span className="ml-auto text-[11px] text-muted-foreground">new rule</span>
              </DropdownMenuItem>
              {b.sandboxes.size === 1 && (
                <DropdownMenuItem onClick={() => onDecide("allow-one", b)}>
                  <Users />Groups of {[...b.sandboxes][0]}
                </DropdownMenuItem>
              )}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button variant="ghost" size="sm" className="h-7 rounded-lg px-2.5 text-[12px] text-muted-foreground hover:text-red-700" onClick={() => onDecide("block-org", b)} title="Add to the shared blocked hosts">
          Block everywhere
        </Button>
      </span>
    </li>
  )
}

function Section({ title, count, actions, children }) {
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-[16px] font-semibold tracking-[-0.01em]">{title}</h3>
        {count != null && <span className="rounded-full bg-muted px-2 py-px text-[12px] tabular-nums text-muted-foreground">{count}</span>}
        {actions && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  )
}

function ColumnHead({ className, children }) {
  return <div className={cn("sticky top-0 z-10 grid h-9 items-center gap-4 border-b border-border bg-muted px-6 text-xs font-medium text-muted-foreground", className)}>{children}</div>
}

function ActionPill({ action }) {
  return action === "block"
    ? <span className="w-fit rounded-full border border-red-200 bg-red-50 px-2 py-px text-[11.5px] text-red-700">Block</span>
    : <span className="w-fit rounded-full border border-emerald-600/20 bg-emerald-50 px-2 py-px text-[11.5px] text-emerald-800">Allow</span>
}

function Hosts({ hosts }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="truncate font-mono text-[11px] text-muted-foreground" title={hosts.join("\n")}>{hosts.slice(0, 3).join(", ")}</span>
      {hosts.length > 3 && <span className="shrink-0 text-[11px] text-faint">+{hosts.length - 3}</span>}
    </span>
  )
}

// One row per network rule, with how many of the sandboxes it covers
// already enforce it. The shared blocked hosts sit on top, since they beat
// every rule.
function RuleSelection({ label, checked, mixed = false, disabled, onChange }) {
  const ref = React.useRef(null)
  React.useEffect(() => { if (ref.current) ref.current.indeterminate = mixed }, [mixed])
  return <input ref={ref} type="checkbox" aria-label={label} checked={checked} disabled={disabled} onChange={onChange}
    className="block size-4 cursor-pointer rounded border-border accent-[var(--action)] focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed" />
}

function PolicyRows({ policies, org, sandboxes, groups, assignments, setupMembers, onEdit, onEditBlocked, onClearBlocked, selected, onSelect, onSelectAll, onDelete, deleting }) {
  const blocked = org?.org?.blocked ?? []
  const matchingSelected = policies.filter((p) => selected.has(p.id)).length
  const allSelected = policies.length > 0 && matchingSelected === policies.length
  return (
    <>
      <ColumnHead className={POLICY_COLS}><RuleSelection label="Select all matching network rules" checked={allSelected} mixed={matchingSelected > 0 && !allSelected} disabled={deleting || !policies.length} onChange={onSelectAll} /><span>Rule</span><span>Action</span><span>Destinations</span><span>Groups</span><span>Enforced</span><span className="text-right">Actions</span></ColumnHead>
      <ul className="divide-y divide-border/60">
        {blocked.length > 0 && (
          <li className={cn("grid min-h-10 items-center gap-4 px-6 py-2 transition-colors hover:bg-muted/60", POLICY_COLS)}>
            <span />
            <button onClick={onEditBlocked} aria-label="Edit blocked everywhere" className="col-span-5 grid grid-cols-subgrid items-center gap-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <span className="flex min-w-0 items-center gap-2.5"><ShieldOff aria-hidden="true" strokeWidth={1.5} className="size-3.5 shrink-0 text-muted-foreground" /><span className="truncate text-xs font-medium">Blocked everywhere</span></span>
              <ActionPill action="block" />
              <Hosts hosts={blocked} />
              <span className="truncate text-xs text-muted-foreground">Every sandbox · beats every rule</span>
              <span className="text-[12px] text-faint">Always</span>
            </button>
            <Button variant="ghost" size="sm" className="h-7 justify-self-end px-2 text-xs text-muted-foreground hover:text-destructive" aria-label="Clear blocked everywhere" disabled={deleting} onClick={onClearBlocked}><Trash2 className="size-3.5" />Delete</Button>
          </li>
        )}
        {policies.map((p) => {
          const targets = sandboxes.filter((s) => appliesTo(p, { name: s.name, groups: groupFor({ assignments }, s.name), setups: setupMembers?.[s.name] ?? [] }))
          const enforced = targets.filter((s) => s.status === "loaded" && s.rules.some((r) => r.key === `egress_${p.id}`)).length
          return (
            <li key={p.id} className={cn("grid min-h-10 items-center gap-4 px-6 py-2 transition-colors hover:bg-muted/60", POLICY_COLS, selected.has(p.id) && "bg-accent/40")}>
              <RuleSelection label={`Select ${p.name}`} checked={selected.has(p.id)} disabled={deleting} onChange={() => onSelect(p.id)} />
              <button onClick={() => onEdit(p)} disabled={deleting} aria-label={`Edit ${p.name}`} className="col-span-5 grid grid-cols-subgrid items-center gap-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <span className="flex min-w-0 items-center gap-2.5"><ShieldCheck aria-hidden="true" strokeWidth={1.5} className="size-3.5 shrink-0 text-muted-foreground" /><span className="truncate text-xs font-medium">{p.name}</span></span>
                <ActionPill action={p.action} />
                <Hosts hosts={p.destinations} />
                <span className="truncate text-xs text-muted-foreground">{p.appliesTo.everyone || p.appliesTo.sandboxes.length || !p.appliesTo.groups.length ? <span className="text-amber-700" title={`Current scope: ${appliesToText(p, groups) || "none"}`}>Assign a group</span> : appliesToText(p, groups)}</span>
                {targets.length ? <Coverage n={enforced} total={targets.length} /> : <span className="text-[12px] text-faint">No sandboxes</span>}
              </button>
              <Button variant="ghost" size="sm" className="h-7 justify-self-end px-2 text-xs text-muted-foreground hover:text-destructive" aria-label={`Delete ${p.name}`} disabled={deleting} onClick={() => onDelete([p])}><Trash2 className="size-3.5" />Delete</Button>
            </li>
          )
        })}
      </ul>
    </>
  )
}

function FleetSummary({ fleet, org, events, onOpen, onOpenGlobal, onDecide, onNavigate, onRefresh, onEditPolicy, onAddPolicy, onEditBlocked, onClearBlocked, forSandbox, onClearSandbox }) {
  const api = useApi()
  const [selected, setSelected] = React.useState(() => new Set())
  const [deleteTargets, setDeleteTargets] = React.useState(null)
  const [deleting, setDeleting] = React.useState(false)
  const [deleteErrors, setDeleteErrors] = React.useState([])
  const deletionInFlight = React.useRef(false)
  const [sourceFilter, setSourceFilter] = React.useState("all")
  const [query, setQuery] = React.useState("")
  const [limit, setLimit] = React.useState(100)
  const [view, setView] = React.useState("rules")
  const [now, setNow] = React.useState(Date.now)
  const search = React.useRef(null)
  const scroll = React.useRef(null)
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000)
    const onKey = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); search.current?.focus() }
    }
    window.addEventListener("keydown", onKey)
    return () => { clearInterval(timer); window.removeEventListener("keydown", onKey) }
  }, [])
  React.useEffect(() => { setLimit(100); scroll.current?.scrollTo({ top: 0 }) }, [query, sourceFilter, view])
  const points = React.useMemo(() => bucketEgress(events, 15, now), [events, now])
  const sandboxes = fleet.sandboxes
  const total = sandboxes.length
  const policies = org?.policies ?? []
  const groups = org?.groups ?? []

  const { destinations, blocked, perSandbox } = React.useMemo(() => {
    const dest = new Map()
    const allowedBy = new Map()
    const perSandbox = new Map()
    for (const s of sandboxes) {
      const hosts = new Set()
      const counts = {}
      for (const r of s.rules) {
        const src = sourceOf(r.key)
        counts[src] = (counts[src] ?? 0) + 1
        for (const e of r.endpoints) {
          if (e.blocked) continue
          hosts.add(e.host)
          const d = dest.get(e.host) ?? { host: e.host, sources: new Set(), access: new Set(), ports: new Set(), sandboxes: new Set(), grants: [], hits: 0, hitsBySandbox: new Map() }
          d.sources.add(src); d.access.add(e.access); e.ports.forEach((p) => d.ports.add(p)); d.sandboxes.add(s.name)
          let grant = d.grants.find((g) => g.sandbox === s.name && g.key === r.key)
          if (!grant) {
            grant = { sandbox: s.name, key: r.key, source: src, access: [], ports: [] }
            d.grants.push(grant)
          }
          grant.access.push(e.access)
          grant.ports.push(...e.ports)
          dest.set(e.host, d)
        }
      }
      allowedBy.set(s.name, hosts)
      perSandbox.set(s.name, { counts, blocked: 0 })
    }
    const block = new Map()
    for (const e of events) {
      if (e.kind !== "audit" || !e.verdict) continue
      const host = hostOf(e.destination)
      if (!host || isIp(host)) continue
      if (e.verdict === "allowed") { const d = dest.get(host); if (d) { d.hits += 1; d.hitsBySandbox.set(e.sandbox, (d.hitsBySandbox.get(e.sandbox) ?? 0) + 1) }; continue }
      if (e.verdict !== "denied" || allowedBy.get(e.sandbox)?.has(host)) continue
      const b = block.get(host) ?? { host, port: portOf(e.destination), sandboxes: new Set(), attempts: 0, programs: new Set(), lastAt: null }
      b.attempts += 1; b.sandboxes.add(e.sandbox)
      if (e.binary) b.programs.add(e.binary)
      if (e.at && (!b.lastAt || e.at > b.lastAt)) b.lastAt = e.at
      block.set(host, b)
      const p = perSandbox.get(e.sandbox); if (p) p.blocked += 1
    }
    // Hosts a block already decides are not waiting for anyone.
    const decided = blockPatterns([...(org?.org?.blocked ?? []), ...(org?.policies ?? []).filter((p) => p.action === "block").flatMap((p) => p.destinations)])
    return {
      destinations: [...dest.values()].sort((a, b) => b.sandboxes.size - a.sandboxes.size || b.hits - a.hits || a.host.localeCompare(b.host)),
      blocked: [...block.values()].filter((b) => !decided.some((pattern) => hostMatches(pattern, b.host))).sort((a, b) => b.sandboxes.size - a.sandboxes.size || b.attempts - a.attempts),
      perSandbox,
    }
  }, [sandboxes, events, org])

  const enforced = sandboxes.filter((s) => s.status === "loaded").length
  const needle = query.trim().toLowerCase()
  const filteredDestinations = destinations.filter((d) => (sourceFilter === "all" || d.sources.has(sourceFilter)) && (!needle || [d.host, ...d.grants.flatMap((g) => [g.sandbox, g.key])].join(" ").toLowerCase().includes(needle)))
  const destinationCount = filteredDestinations.length
  const sourceOptions = [{ id: "all", label: "All" }, ...SOURCE_ORDER.filter((s) => destinations.some((d) => d.sources.has(s))).map((s) => ({ id: s, label: SOURCE[s].label }))]

  const filteredBlocked = blocked.filter((b) => !needle || [b.host, ...b.programs, ...b.sandboxes].join(" ").toLowerCase().includes(needle))
  const filteredBoxes = sandboxes.filter((s) => !needle || s.name.toLowerCase().includes(needle))
  // Opened for one sandbox: only the policies that reach it.
  const reaches = (p) => !forSandbox || appliesTo(p, { name: forSandbox, groups: groupFor(org, forSandbox), setups: org?.setupMembers?.[forSandbox] ?? [] })
  const filteredPolicies = policies.filter((p) => reaches(p)).filter((p) => !needle || [p.name, p.action, ...p.destinations, appliesToText(p, groups)].join(" ").toLowerCase().includes(needle))
  const selectedPolicies = policies.filter((p) => selected.has(p.id))
  const matchingSelected = filteredPolicies.filter((p) => selected.has(p.id)).length
  function toggleSelected(id) {
    setSelected((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next })
  }
  function toggleMatching() {
    setSelected((current) => {
      const next = new Set(current)
      const all = filteredPolicies.every((p) => current.has(p.id))
      for (const p of filteredPolicies) { if (all) next.delete(p.id); else next.add(p.id) }
      return next
    })
  }
  async function deleteSelected() {
    if (deletionInFlight.current || !deleteTargets?.length) return
    deletionInFlight.current = true
    setDeleting(true); setDeleteErrors([])
    try {
      const result = await deleteNetworkPolicies(deleteTargets, (id) => api.deletePolicy(id))
      setSelected((current) => {
        const next = new Set(current)
        result.deleted.forEach((id) => next.delete(id))
        result.failed.forEach(({ id }) => next.add(id))
        return next
      })
      setDeleteErrors(result.failed)
      if (result.deleted.length) toast.success(`Deleted ${plural(result.deleted.length, "network rule")}`)
      if (result.failed.length) toast.error(`${plural(result.failed.length, "network rule")} could not be deleted. Review the errors and retry.`)
      if (result.syncFailures.length) toast.warning("Rules deleted, but some sandboxes could not be updated", { description: result.syncFailures.map((f) => `${f.rule} · ${f.sandbox}: ${f.error}`).join("\n") })
      setDeleteTargets(null)
      await onRefresh()
    } finally { setDeleting(false); deletionInFlight.current = false }
  }
  const count = view === "rules" ? filteredPolicies.length : view === "destinations" ? destinationCount : view === "blocked" ? filteredBlocked.length : filteredBoxes.length
  const allCount = view === "rules" ? policies.length : view === "destinations" ? destinations.length : view === "blocked" ? blocked.length : total
  const filtering = Boolean(query || (view === "destinations" && sourceFilter !== "all"))
  const clear = () => { setQuery(""); setSourceFilter("all") }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 px-4 pt-4 pb-3 sm:px-6">
        <div className="flex flex-wrap gap-1" role="group" aria-label="Egress inventory">
          {[{ id: "rules", label: "Rules", count: policies.length }, { id: "destinations", label: "Destinations", count: destinations.length }, { id: "blocked", label: "Blocked hosts", count: blocked.length, dot: "bg-red-500" }, { id: "sandboxes", label: "Sandboxes", count: total }].map((item) => (
            <button key={item.id} aria-pressed={view === item.id} onClick={() => { setView(item.id); clear() }}
              className={cn("rounded-md px-3 py-1.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring", view === item.id ? "bg-accent/70" : "hover:bg-muted/60")}>
              <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">{item.dot && <span className={cn("size-1.5 rounded-full", item.dot)} />}{item.label}</span>
              <span className="mt-1 block font-mono text-lg leading-none tabular-nums"><NumberTicker value={item.count} /></span>
            </button>
          ))}
        </div>
        <div className="ml-auto hidden w-64 px-3 lg:block"><EgressChart points={points} height={34} title="Connections · 15m" /></div>
      </div>
      <div className="flex h-[3px] shrink-0 overflow-hidden bg-border" role="img" aria-label={`${enforced} of ${total} sandbox policies enforced`}>
        {enforced > 0 && <span className="bg-emerald-400/70" style={{ width: `${enforced / total * 100}%` }} />}
        {total > enforced && <span className="flex-1 bg-amber-400/70" />}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2 sm:px-6">
        <SearchInput ref={search} value={query} onValueChange={setQuery} placeholder={view === "sandboxes" ? "Search sandbox…" : view === "rules" ? "Search rule, destination…" : "Search destination, sandbox, rule…"} aria-label="Search egress" className="mr-auto w-full sm:w-64" />
        {view === "destinations" && <SelectField aria-label="Filter by source" value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)} className="h-8 max-w-44 rounded-md border border-border bg-card px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring">{sourceOptions.map((o) => <option key={o.id} value={o.id}>{o.id === "all" ? "All sources" : o.label}</option>)}</SelectField>}
        {filtering && <Button variant="ghost" size="sm" onClick={clear}><X className="size-3" />Clear</Button>}
        {forSandbox && view === "rules" && <>
          <span className="flex items-center gap-1 rounded-md border border-foreground/20 bg-accent py-0.5 pr-0.5 pl-2 text-[12px]">
            For <span className="font-mono">{forSandbox}</span>
            <button aria-label="Show every rule" onClick={onClearSandbox} className="rounded p-0.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"><X className="size-3" /></button>
          </span>
          <Button variant="ghost" size="sm" onClick={() => onOpen(forSandbox)}>Rules &amp; history<ArrowUpRight className="size-3" /></Button>
        </>}
        <Button variant="ghost" size="icon-sm" aria-label="Refresh egress" onClick={onRefresh}><RefreshCw className="size-3.5" /></Button>
        <Button size="sm" className="bg-[var(--action)] text-[var(--action-foreground)] hover:bg-[var(--action)]/90" onClick={onAddPolicy}><Plus className="size-3.5" />Add rule</Button>
      </div>
      {view === "rules" && selectedPolicies.length > 0 && <div className="flex flex-wrap items-center gap-3 border-b border-border bg-accent/30 px-6 py-2">
        <span role="status" className="mr-auto text-xs"><strong>{selectedPolicies.length}</strong> selected{selectedPolicies.length > matchingSelected && <span className="text-muted-foreground"> · {selectedPolicies.length - matchingSelected} outside current filters</span>}</span>
        <Button variant="ghost" size="sm" disabled={deleting} onClick={() => setSelected(new Set())}>Clear selection</Button>
        <Button variant="destructive" size="sm" disabled={deleting} onClick={() => setDeleteTargets([...selectedPolicies])}><Trash2 className="size-3.5" />{deleting ? "Deleting…" : "Delete selected"}</Button>
      </div>}
      {sandboxes.some((s) => s.source === "global") && <div role="status" className="flex flex-wrap items-center gap-2 border-b border-amber-500/30 bg-amber-50/60 px-6 py-2 text-xs text-amber-800">
        <AlertTriangle className="size-3.5" /><span className="mr-auto">A global policy overrides every sandbox's network rules.</span>
        <Button variant="outline" size="sm" onClick={onOpenGlobal}>Review</Button>
      </div>}
      {deleteErrors.length > 0 && <Notice id="egress:delete-errors" tone="error" title="Some rules could not be deleted" onDismiss={() => setDeleteErrors([])} dismissLabel="Dismiss deletion errors">
        <p>Failed rules remain selected for retry.</p>
        <ul className="mt-1 max-h-28 overflow-auto">{deleteErrors.map((error) => <li key={error.id}><strong className="text-foreground">{error.name}</strong>: {error.message}</li>)}</ul>
      </Notice>}
      <div ref={scroll} tabIndex={0} role="region" aria-label="Egress inventory results" className="min-h-0 flex-1 overflow-auto overscroll-contain outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
        {count === 0 && !(view === "rules" && !filtering && org?.org?.blocked?.length) ? <div className="py-20 text-center"><Globe2 className="mx-auto mb-3 size-6 text-muted-foreground" /><p className="text-sm">{filtering ? "No matching results" : view === "rules" ? (forSandbox ? `No rule applies to ${forSandbox} yet` : "No network rules yet") : view === "blocked" ? "No blocked hosts to review" : view === "sandboxes" ? "No sandboxes yet" : "No open destinations"}</p><p className="mt-2 text-xs text-muted-foreground">{!filtering && view === "rules" ? "Sandboxes are locked down: nothing leaves them until a rule allows it." : !filtering && view === "destinations" ? "Destinations appear when a sandbox policy allows access." : !filtering && view === "blocked" ? "Blocked connection attempts will appear here." : ""}</p>{filtering ? <Button variant="outline" className="mt-4" onClick={clear}>Clear filters</Button> : view === "rules" && <Button className="mt-4 bg-[var(--action)] text-[var(--action-foreground)] hover:bg-[var(--action)]/90" onClick={onAddPolicy}><Plus />Add rule</Button>}</div> : (
          <div className="min-w-[960px] bg-card">
            {view === "rules" && <PolicyRows policies={filteredPolicies} org={filtering ? null : org} sandboxes={sandboxes} groups={groups} assignments={org?.assignments} setupMembers={org?.setupMembers} onEdit={onEditPolicy} onEditBlocked={onEditBlocked} onClearBlocked={onClearBlocked} selected={selected} onSelect={toggleSelected} onSelectAll={toggleMatching} onDelete={setDeleteTargets} deleting={deleting} />}
            {view === "destinations" && <>
              <ColumnHead className={DEST_COLS}><span>Destination</span><span>Source</span><span>Access</span><span>Sandboxes</span><span className="text-right">Requests</span><span /></ColumnHead>
              <ul className="divide-y divide-border/60">{filteredDestinations.slice(0, limit).map((d) => <DestinationRow key={d.host} d={d} total={total} onOpen={onOpen} />)}</ul>
            </>}
            {view === "blocked" && <>
              <ColumnHead className={BLOCK_COLS}><span>Destination</span><span>Sandboxes</span><span>Attempts</span><span>Program</span><span className="text-right">Actions</span></ColumnHead>
              <ul className="divide-y divide-border/60">{filteredBlocked.slice(0, limit).map((b) => <BlockedRow key={b.host} b={b} onDecide={onDecide} />)}</ul>
            </>}
            {view === "sandboxes" && <>
              <ColumnHead className={BOX_COLS}><span>Sandbox</span><span>Rules by source</span><span>Policy</span><span className="text-right">Blocked</span><span /></ColumnHead>
          <ul className="divide-y divide-border/70">
            {filteredBoxes.slice(0, limit).map((s) => {
              const info = perSandbox.get(s.name) ?? { counts: {}, blocked: 0 }
              return (
                <li key={s.name}>
                  <button onClick={() => onOpen(s.name)} className={cn("grid min-h-10 w-full items-center gap-4 px-6 py-2 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:bg-muted/60", BOX_COLS)}>
                    <span className="flex min-w-0 items-center gap-2.5">
                      <span className={cn("size-2 shrink-0 rounded-[3px]", styleOf(s.phase).cell)} aria-hidden="true" />
                      <span className="truncate font-mono text-xs">{s.name}</span>
                    </span>
                    <span className="items-center gap-3 flex">
                      {SOURCE_ORDER.filter((k) => info.counts[k]).map((k) => (
                        <span key={k} className="flex items-center gap-1.5 text-[12px] tabular-nums" title={SOURCE[k].label}><span className={cn("size-1.5 rounded-full", SOURCE[k].swatch)} />{info.counts[k]}</span>
                      ))}
                    </span>
                    <span className="items-center gap-1.5 text-[12px] flex">
                      <span className={cn("size-1.5 rounded-full", REVISION[s.status]?.dot ?? "bg-stone-200")} />{s.error ? "Unavailable" : s.version ? `v${s.version} ${REVISION[s.status]?.label.toLowerCase()}` : "-"}
                    </span>
                    <span className={cn("text-right text-[12px] tabular-nums", info.blocked ? "text-red-600/90" : "text-faint")}>{info.blocked || "-"}</span>
                    <ChevronRight className="size-3.5 text-faint" aria-hidden="true" />
                  </button>
                </li>
              )
            })}
          </ul>
            </>}
            {view !== "rules" && count > limit && <button onClick={() => setLimit((n) => n + 100)} className="w-full border-t border-border py-3 text-xs text-muted-foreground outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring">Show {Math.min(100, count - limit)} more</button>}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border bg-card px-6 py-2 text-[11px] text-muted-foreground">
        <span><strong className="font-medium text-foreground">{count.toLocaleString()}</strong>{filtering ? ` of ${allCount.toLocaleString()}` : ""} {view === "blocked" ? "blocked hosts" : view}</span>
        <span className="hidden sm:inline">{enforced}/{total} policies enforced · ⌘K to search</span>
      </div>
      <AlertDialog open={deleteTargets !== null} onOpenChange={(open) => { if (!open && !deletionInFlight.current) setDeleteTargets(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {plural(deleteTargets?.length ?? 0, "network rule")}?</AlertDialogTitle>
            <AlertDialogDescription>Removes these rules and updates the affected sandboxes. Deleting an allow rule can remove access; deleting a block rule can permit access allowed by other rules. Each sandbox must keep at least one network rule across its groups.</AlertDialogDescription>
          </AlertDialogHeader>
          <ul aria-label="Network rules to delete" className="max-h-48 overflow-auto rounded-md border border-border p-3 text-xs">{deleteTargets?.map((p) => <li key={p.id} className="break-all py-1">{p.name}</li>)}</ul>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={deleting || !deleteTargets?.length} onClick={deleteSelected}>{deleting ? "Deleting…" : "Delete rules"}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ---- one sandbox ------------------------------------------------------------

// Adding one method/path pair to an endpoint: the smallest widening there is.
function InlineRequest({ kind, onAdd }) {
  const [open, setOpen] = React.useState(false)
  const [method, setMethod] = React.useState("GET")
  const [path, setPath] = React.useState("")
  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className={cn("flex items-center gap-1 text-[12px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring", kind === "deny" ? "text-red-600/80 hover:text-red-700" : "text-muted-foreground hover:text-foreground")}>
        <Plus className="size-3" />{kind === "deny" ? "Block request" : "Allow request"}
      </button>
    )
  }
  return (
    <form className="flex items-center gap-1.5" onSubmit={async (e) => { e.preventDefault(); if (await onAdd({ method, path })) { setOpen(false); setPath("") } }}>
      <SelectField value={method} onChange={(e) => setMethod(e.target.value)} aria-label="Method" className="h-7 rounded-md border border-input bg-card px-1 font-mono text-[11px]">
        {METHODS.map((m) => <option key={m}>{m}</option>)}
      </SelectField>
      <Input value={path} onChange={(e) => setPath(e.target.value)} className="h-7 w-48 bg-card font-mono text-[11px]" placeholder="/path/**" aria-label="Path pattern" autoFocus />
      <Button type="submit" size="xs" variant={kind === "deny" ? "destructive" : "outline"} disabled={!path.startsWith("/")}>{kind === "deny" ? "Block" : "Allow"}</Button>
      <Button type="button" size="icon-xs" variant="ghost" onClick={() => setOpen(false)} aria-label="Cancel"><X /></Button>
    </form>
  )
}

function accessSummary(rule) {
  const set = [...new Set(rule.endpoints.map((e) => ACCESS_LABEL[e.access] ?? e.access))]
  return set.length === 1 ? set[0] : "Mixed"
}

function RuleRow({ rule, onOp, onDelete, busy, locked, managedBy, onManage }) {
  const [open, setOpen] = React.useState(false)
  const source = sourceOf(rule.key)
  const Icon = ICON[source]
  const hosts = rule.endpoints.map((e) => e.host)
  const risky = rule.endpoints.some((e) => (e.protocol !== "tcp" && e.enforcement === "audit") || e.credentialRisk)

  return (
    <div>
      <button onClick={() => setOpen(!open)} aria-expanded={open}
        className="flex w-full items-center gap-4 px-5 py-3.5 text-left outline-none transition-colors hover:bg-stone-50/70 focus-visible:bg-stone-50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-linear-to-b from-card to-stone-100" title={SOURCE[source].label}>
          <Icon strokeWidth={1.5} className="size-3.5 text-stone-600" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-[13.5px] font-medium">{displayName(rule.key)}</span>
            {risky && <AlertTriangle className="size-3 shrink-0 text-amber-600" aria-label="Audit only or uninspected" />}
          </span>
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5">
            <span className="truncate font-mono text-[11.5px] text-muted-foreground">{hosts[0]}</span>
            {hosts.length > 1 && <span className="shrink-0 text-[11.5px] text-faint">+{hosts.length - 1}</span>}
          </span>
        </span>
        <span className="hidden shrink-0 sm:block"><SourcePill source={source} /></span>
        <span className="hidden w-24 shrink-0 text-[12px] text-muted-foreground sm:block">{accessSummary(rule)}</span>
        <span className="hidden w-28 shrink-0 truncate text-right font-mono text-[11px] text-faint lg:block">{[...new Set(rule.binaries.map(program))].join(", ")}</span>
        <ChevronRight className={cn("size-3.5 shrink-0 text-faint transition-transform duration-200", open && "rotate-90 text-muted-foreground")} aria-hidden="true" />
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }} className="overflow-hidden">
            <div className="space-y-4 px-5 pt-1 pb-5 pl-[4.25rem]">
              {source === "agent" && <p className="text-xs text-muted-foreground">Included for this agent at launch. Only the destinations and programs listed here are allowed by this rule.</p>}
              {rule.endpoints.map((e) => (
                <div key={`${e.host}:${e.ports.join(",")}:${e.path ?? ""}`} className="space-y-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-[12.5px] font-medium">{e.host}<span className="text-muted-foreground">{e.ports.length ? `:${e.ports.join(",")}` : ""}</span>{e.path ? ` ${e.path}` : ""}</span>
                    <Chip>{e.protocol}</Chip>
                    <Chip>{(ACCESS_LABEL[e.access] ?? e.access).toLowerCase()}</Chip>
                    {e.protocol !== "tcp" && e.enforcement === "audit" && <Chip tone="border-amber-500/40 bg-amber-50 text-amber-800" title={e.enforcementUnset ? "Unset, treated as audit" : undefined}>audit only</Chip>}
                    {e.allowedIps.length > 0 && <Chip title="Private addresses allowed">ips {e.allowedIps.join(", ")}</Chip>}
                    {e.credentialRisk && <Chip tone="border-amber-500/40 bg-amber-50 text-amber-800" title={e.tlsSkip ? "Encrypted traffic passes through without request inspection" : "Credentials are uninspected"}>{e.tlsSkip ? "TLS passthrough" : "uninspected"}</Chip>}
                    {!locked && rule.endpoints.length > 1 && (
                      <button onClick={() => onOp({ kind: "removeEndpoint", ruleName: rule.key, host: e.host, port: e.port })} disabled={busy}
                        className="ml-auto text-[12px] text-faint outline-none hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring">Remove</button>
                    )}
                  </div>
                  {(e.allow.length > 0 || e.deny.length > 0) && (
                    <ul className="space-y-1 border-l border-border pl-3 font-mono text-[11.5px]">
                      {e.allow.map((r, i) => <li key={`a${i}`}><span className="text-emerald-700">allow</span> <span className="text-foreground/75">{r.method} {r.path}</span></li>)}
                      {e.deny.map((r, i) => <li key={`d${i}`}><span className="text-red-600">block</span> <span className="text-foreground/75">{r.method} {r.path}</span></li>)}
                    </ul>
                  )}
                  {!locked && e.protocol !== "tcp" && (
                    <div className="flex flex-wrap gap-x-5 gap-y-1.5">
                      <InlineRequest kind="allow" onAdd={(match) => onOp({ kind: "addAllow", ruleName: rule.key, host: e.host, ports: e.ports, binaries: rule.binaries, match })} />
                      <InlineRequest kind="deny" onAdd={(match) => onOp({ kind: "addDeny", ruleName: rule.key, host: e.host, ports: e.ports, binaries: rule.binaries, match })} />
                    </div>
                  )}
                </div>
              ))}
              <div className="flex flex-wrap items-center gap-1.5">
                {rule.binaries.map((b) => (
                  <span key={b} title={b} className="flex items-center gap-0.5 rounded-md bg-muted py-0.5 pr-1 pl-2 font-mono text-[10.5px] text-foreground/75">
                    {program(b)}
                    {!locked && rule.binaries.length > 1 ? (
                      <button onClick={() => onOp({ kind: "removeBinary", ruleName: rule.key, binary: b })} disabled={busy} aria-label={`Remove ${b}`}
                        className="rounded p-0.5 text-muted-foreground outline-none hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring"><X className="size-2.5" /></button>
                    ) : <span className="w-1" />}
                  </span>
                ))}
                <span className="ml-auto flex items-center gap-2">
                  {managedBy && (onManage ? <button onClick={onManage} className="text-[12px] text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring">Managed in {managedBy}</button> : <span className="text-[12px] text-muted-foreground">Managed in {managedBy} · Enterprise Version</span>)}
                  {!locked && onDelete && <Button variant="ghost" size="xs" className="text-muted-foreground hover:text-destructive" disabled={busy} onClick={onDelete}><Trash2 />Delete</Button>}
                </span>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function RevisionDots({ revisions, onOpen }) {
  const shown = revisions.slice(0, 10).reverse()
  return (
    <div className="flex items-center gap-1" aria-label="Revisions">
      {shown.map((r, i) => (
        <button key={r.version} onClick={() => onOpen(r.version)} title={`v${r.version} · ${REVISION[r.status]?.label} · ${relativeTime(r.createdAt)}`}
          className={cn("rounded-full outline-none transition-transform hover:scale-125 focus-visible:ring-2 focus-visible:ring-ring",
            i === shown.length - 1 ? "size-2.5" : "size-1.5", REVISION[r.status]?.dot ?? "bg-stone-200")} aria-label={`Revision ${r.version}`} />
      ))}
    </div>
  )
}

function RevisionSheet({ sandbox, version, latest, onClose, onRestore }) {
  const api = useApi()
  const [data, setData] = React.useState(null)
  React.useEffect(() => {
    setData(null)
    if (version == null) return
    api.revision(sandbox, version).then(setData).catch((e) => setData({ error: e.message }))
  }, [sandbox, version, api])
  return (
    <Sheet open={version != null} onOpenChange={(open) => { if (!open) onClose() }}>
      <SheetContent className="w-full! overflow-y-auto sm:max-w-[460px]!">
        <SheetHeader className="border-b p-6">
          <SheetTitle className="font-mono text-base">{sandbox} · v{version}</SheetTitle>
          <SheetDescription>{data?.revision ? `${REVISION[data.revision.status]?.label} · ${absoluteTime(data.revision.createdAt)}` : "Loading…"}</SheetDescription>
        </SheetHeader>
        <div className="space-y-4 px-6 pb-6">
          {data?.error && <p className="text-sm text-muted-foreground">{data.error}</p>}
          {data?.revision?.loadError && <p className="rounded-md border border-red-200 bg-red-50/60 p-2 font-mono text-[11px] text-red-700">{data.revision.loadError}</p>}
          {data?.revision?.provenance?.["console.openshell/change"] && <p className="font-mono text-[11px] text-muted-foreground">{data.revision.provenance["console.openshell/change"]}</p>}
          {data?.policy && (data.policy.rules.length ? (
            <Card className="divide-y divide-border/70 overflow-hidden">{data.policy.rules.map((rule) => <RuleRow key={rule.key} rule={rule} locked onOp={() => {}} />)}</Card>
          ) : <p className="text-[12px] text-muted-foreground">No rules.</p>)}
          {data?.policy && version !== latest && <Button variant="outline" size="sm" onClick={() => onRestore(version)}><RotateCcw />Restore</Button>}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function BackLink({ onClick }) {
  return (
    <button onClick={onClick} className="group flex items-center gap-1.5 text-[12.5px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
      <ArrowLeft className="size-3.5 transition-transform group-hover:-translate-x-0.5" />All sandboxes
    </button>
  )
}

function GlobalPanel({ onBack }) {
  const api = useApi()
  const [data, setData] = React.useState(null)
  const [confirm, setConfirm] = React.useState(false)
  const load = React.useCallback(() => api.globalPolicy().then(setData).catch((e) => setData({ error: e.message })), [api])
  React.useEffect(() => { load() }, [load])
  return (
    <div className="space-y-6 px-4 py-5 sm:px-6">
      <BackLink onClick={onBack} />
      {!data ? <p className="py-16 text-center text-sm text-muted-foreground">Loading…</p> : data.error ? <p className="py-16 text-center text-sm text-muted-foreground">{data.error}</p> : (
        <>
          <div>
            <h2 className="text-xl font-semibold tracking-tight">{data.active ? `Global policy · v${data.current?.revision.version}` : "No global policy"}</h2>
            <p className="mt-3 text-[13px] text-muted-foreground">{data.active ? "Overrides every sandbox's own rules." : "Each sandbox follows its own rules."}</p>
            {data.active && <Button variant="outline" className="mt-5 rounded-lg border-destructive/30 text-destructive hover:bg-destructive/5" onClick={() => setConfirm(true)}><ShieldOff />Remove</Button>}
          </div>
          {data.current?.policy?.rules.length > 0 && <Card className="divide-y divide-border/70 overflow-hidden">{data.current.policy.rules.map((rule) => <RuleRow key={rule.key} rule={rule} locked onOp={() => {}} />)}</Card>}
          {data.revisions.length > 0 && (
            <Section title="History">
              <Card className="divide-y divide-border/60">
                {data.revisions.map((r) => (
                  <div key={r.version} className="flex h-11 items-center gap-3 px-5 text-[12.5px]">
                    <span className={cn("size-1.5 rounded-full", REVISION[r.status]?.dot)} aria-hidden="true" />
                    <span className="font-mono">v{r.version}</span><span className="text-muted-foreground">{REVISION[r.status]?.label}</span><span className="ml-auto text-muted-foreground">{relativeTime(r.createdAt)}</span>
                  </div>
                ))}
              </Card>
            </Section>
          )}
        </>
      )}
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove the global policy?</AlertDialogTitle>
            <AlertDialogDescription>Every sandbox reverts to its own rules.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={async () => {
              try { await api.removeGlobal(); toast.success("Global policy removed"); load() } catch (e) { toast.error(e.message) } finally { setConfirm(false) }
            }}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

const FILTERS = [{ id: "all", label: "All" }, ...SOURCE_ORDER.map((s) => ({ id: s, label: SOURCE[s].label }))]

function SandboxDetail({ name, sandbox, events, onBack, onNavigate, onDraft, onEditPolicy, onOpenGlobal, reloadSignal }) {
  const api = useApi()
  const location = useLocation()
  const [policy, setPolicy] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const [deleting, setDeleting] = React.useState(null)
  const [viewing, setViewing] = React.useState(null)
  const [filter, setFilter] = React.useState("all")

  const load = React.useCallback(async () => {
    try { const p = await api.policy(name); setPolicy(p); return p } catch (e) { setPolicy({ error: e.message }) }
  }, [name, api])
  React.useEffect(() => { setPolicy(null); load() }, [load])
  React.useEffect(() => { if (reloadSignal) load() }, [reloadSignal]) // eslint-disable-line react-hooks/exhaustive-deps

  // A new revision is accepted before the sandbox loads it. Follow it until
  // the sandbox reports it active or failed, so "applied" means enforced.
  async function follow(version) {
    for (let i = 0; i < 20; i++) {
      const p = await load()
      const r = p?.revisions?.find((x) => x.version === version)
      if (r?.status === "loaded") { toast.success(`Policy v${version} is enforced in ${name}`); return }
      if (r?.status === "failed") { toast.error(`v${version} failed to load: ${r.loadError ?? "unknown error"}`); return }
      await new Promise((resolve) => setTimeout(resolve, 1500))
    }
    toast.warning(`v${version} saved; not yet loaded by ${name}`)
  }
  async function apply(ops) {
    setBusy(true)
    try { const result = await api.applyOps(name, ops); toast(`Saved as v${result.version}`); follow(result.version); return true }
    catch (e) { toast.error(e.message); return false } finally { setBusy(false) }
  }
  async function restore(version) {
    setBusy(true)
    try { const result = await api.restore(name, version); toast(`Restored v${version} as v${result.version}`); setViewing(null); follow(result.version) }
    catch (e) { toast.error(e.message) } finally { setBusy(false) }
  }

  const rules = policy?.effective?.rules ?? []
  const allowedHosts = new Set(rules.flatMap((r) => r.endpoints.filter((e) => !e.blocked).map((e) => e.host)))
  const denied = React.useMemo(() => {
    const map = new Map()
    for (const e of events) {
      if (e.sandbox !== name || e.verdict !== "denied") continue
      const host = hostOf(e.destination)
      if (!host || isIp(host) || allowedHosts.has(host)) continue
      const entry = map.get(host) ?? { host, port: portOf(e.destination), count: 0, binary: null, lastAt: null }
      entry.count += 1
      if (!entry.binary && e.binary) entry.binary = e.binary
      if (e.at && (!entry.lastAt || e.at > entry.lastAt)) entry.lastAt = e.at
      map.set(host, entry)
    }
    return [...map.values()].sort((a, b) => b.count - a.count)
  }, [events, name, policy]) // eslint-disable-line react-hooks/exhaustive-deps

  const globalActive = policy?.source === "global"
  const counts = Object.fromEntries(FILTERS.map((f) => [f.id, rules.filter((r) => f.id === "all" || sourceOf(r.key) === f.id).length]))
  const shown = rules.filter((r) => filter === "all" || sourceOf(r.key) === filter)

  return (
    <div className="space-y-6 px-4 py-5 sm:px-6">
      <div className="space-y-5">
        <BackLink onClick={onBack} />
        {!policy ? <p role="status" className="py-16 text-center text-sm text-muted-foreground">Loading…</p> : policy.error ? (
          <p role="alert" className="py-16 text-center text-sm text-muted-foreground">{policy.error}</p>
        ) : (
          <header className="flex flex-wrap items-end gap-x-6 gap-y-4">
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
                <span className={cn("size-2 rounded-[3px]", styleOf(sandbox?.phase).cell)} />Sandbox
              </p>
              <h2 className="mt-2 truncate text-xl font-semibold tracking-tight">{name}</h2>
              <div className="mt-4 flex flex-wrap items-center gap-4">
                {policy.latest && (
                  <span className={cn("flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[12px]", REVISION[policy.latest.status]?.cls)}>
                    <span className="relative flex size-1.5">
                      {policy.latest.status === "loaded" && <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-60" />}
                      <span className={cn("relative inline-flex size-1.5 rounded-full", REVISION[policy.latest.status]?.dot)} />
                    </span>
                    v{policy.latest.version} {REVISION[policy.latest.status]?.label.toLowerCase()}
                  </span>
                )}
                <RevisionDots revisions={policy.revisions} onOpen={setViewing} />
                <span className="text-[12.5px] text-muted-foreground tabular-nums">{plural(allowedHosts.size, "destination")} open</span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" className="rounded-lg" onClick={() => { try { sessionStorage.setItem("gateway-box", location ? JSON.stringify({ name, location }) : name) } catch { /* optional */ } onNavigate("sandboxes") }}>
                <Network />View sandbox
              </Button>
              <Button className="rounded-lg bg-[var(--action)] text-[var(--action-foreground)] hover:bg-[var(--action)]/90" disabled={busy || globalActive} onClick={() => onDraft(null, follow)}>
                <Plus />Add rule
              </Button>
            </div>
          </header>
        )}
      </div>

      {policy && !policy.error && (
        <>
          {globalActive && <div className="flex flex-wrap items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-50/60 px-4 py-2 text-[12.5px] text-amber-800"><AlertTriangle className="size-3.5" /><span className="mr-auto">Global policy in force · editing disabled</span><Button variant="outline" size="sm" onClick={onOpenGlobal}>Review</Button></div>}
          {policy.configurationError && <p className="rounded-xl border border-red-200 bg-red-50/60 px-4 py-3 font-mono text-[11.5px] text-red-700">{policy.configurationError}</p>}

          {denied.length > 0 && !globalActive && (
            <Section title="Blocked recently" count={denied.length}>
              <Card className="divide-y divide-border/70 overflow-hidden">
                {denied.slice(0, 6).map((d) => (
                  <div key={d.host} className="flex items-center gap-3 px-5 py-3">
                    <HostTile host={d.host} tone="denied" className="size-7 text-[15px]" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-[12.5px]">{d.host}<span className="text-muted-foreground">:{d.port}</span></span>
                      <span className="block text-[11.5px] text-muted-foreground">{d.binary ? program(d.binary) : "Unknown program"}{d.lastAt ? ` · ${relativeTime(d.lastAt)}` : ""}</span>
                    </span>
                    <span className="text-[12px] tabular-nums text-red-600/90">{d.count}×</span>
                    <Button variant="outline" size="sm" className="h-7 rounded-lg text-[12px]" onClick={() => onDraft({
                      name: slug(d.host), binaries: d.binary ? [d.binary] : [],
                      endpoints: [{ host: d.host, ports: [d.port], protocol: d.port === 443 || d.port === 80 ? "rest" : "tcp", access: "read-only", enforcement: "enforce" }],
                    }, follow)}>Allow</Button>
                  </div>
                ))}
              </Card>
            </Section>
          )}

          <Section title="Rules" count={rules.length}
            actions={<Segmented label="Filter rules" options={FILTERS.filter((f) => f.id === "all" || counts[f.id] > 0).map((f) => ({ ...f, count: counts[f.id] }))} value={filter} onChange={setFilter} />}>
            {shown.length === 0 ? (
              <Card className="flex flex-col items-center border-dashed py-12 shadow-none"><p className="text-[13px] text-muted-foreground">No rules yet</p></Card>
            ) : (
              <Card className="divide-y divide-border/70 overflow-hidden">
                {shown.map((rule) => {
                  const source = sourceOf(rule.key)
                  return (
                    <RuleRow key={rule.key} rule={rule} busy={busy} locked={!["own", "agent"].includes(source) || globalActive}
                      onOp={(op) => apply([op])} onDelete={["own", "agent"].includes(source) ? () => setDeleting(rule.key) : null}
                      managedBy={source === "secret" ? "Secrets" : source === "policy" ? "Network rules" : ["org", "group"].includes(source) ? "Organization" : null}
                      onManage={source === "secret" ? () => onNavigate("secrets") : source === "policy" ? () => onEditPolicy(rule.key.replace(/^egress_/, "")) : undefined} />
                  )
                })}
              </Card>
            )}
          </Section>

        </>
      )}

      <AlertDialog open={Boolean(deleting)} onOpenChange={(open) => { if (!open) setDeleting(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete rule {deleting}?</AlertDialogTitle>
            <AlertDialogDescription>{name} loses access immediately. Restorable from revisions.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={async () => { await apply([{ kind: "removeRule", ruleName: deleting }]); setDeleting(null) }}>Delete rule</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <RevisionSheet sandbox={name} version={viewing} latest={policy?.revisions?.[0]?.version} onClose={() => setViewing(null)} onRestore={restore} />
    </div>
  )
}

// ---- page -------------------------------------------------------------------

// A rule for one sandbox, pre-filled from a blocked connection another page handed over.
function ruleFor(b) {
  const web = b.port === 443 || b.port === 80
  return {
    name: slug(b.host),
    binaries: [...b.programs],
    endpoints: [{ host: b.host, ports: [b.port], protocol: web ? "rest" : "tcp", ...(web ? { access: "read-only" } : {}), enforcement: "enforce" }],
  }
}

// Other pages open a pre-filled rule here: { sandbox, host, port, binary } as JSON.
export const ALLOW_HANDOFF = "egress-allow"
// Other pages open the network rules that reach one sandbox: its name.
export const SANDBOX_HANDOFF = "egress-sandbox"
// Other pages open the rule editor here: { new: { appliesTo } } or { edit: id }.
// A page shown while Egress stays open also dispatches a window event of this name.
export const POLICY_HANDOFF = "egress-policy"
const takePolicyHandoff = () => {
  try { const d = JSON.parse(sessionStorage.getItem(POLICY_HANDOFF) ?? "null"); sessionStorage.removeItem(POLICY_HANDOFF); return d } catch { return null }
}

export function EgressView(props) {
  const location = useLocation()
  return <ScopedEgressView key={location?.id ?? location?.context ?? "default"} {...props} />
}

function ScopedEgressView({ onNavigate: navigate }) {
  const api = useApi()
  const location = useLocation()
  const onNavigate = (view) => navigate(view, location)
  const live = useLive()
  const [scope, setScope] = React.useState(null)
  const [showGlobal, setShowGlobal] = React.useState(false)
  // Other pages hand over one sandbox to show the rules that reach it.
  const [forSandbox, setForSandbox] = React.useState(() => {
    try { const s = sessionStorage.getItem(SANDBOX_HANDOFF); sessionStorage.removeItem(SANDBOX_HANDOFF); return s } catch { return null }
  })
  const [fleet, setFleet] = React.useState(null)
  const [org, setOrg] = React.useState(null)
  const [editor, setEditor] = React.useState(null)
  const [policyEditor, setPolicyEditor] = React.useState(null)
  const [editingBlocked, setEditingBlocked] = React.useState(false)
  const [clearingBlocked, setClearingBlocked] = React.useState(false)
  const [busyBlocked, setBusyBlocked] = React.useState(false)
  const [pending, setPending] = React.useState(null)
  const [signal, setSignal] = React.useState(0)
  const scroller = React.useRef(null)

  const loadFleet = React.useCallback(async () => {
    try { setFleet(await api.fleetPolicy()) } catch (e) { setFleet({ error: e.message, sandboxes: [] }) }
    try { setOrg(await api.org()) } catch { setOrg(null) }
  }, [api])
  React.useEffect(() => { loadFleet() }, [loadFleet])

  // The Groups page hands over a rule to add for a group, or one to edit.
  const [policyHandoff, setPolicyHandoff] = React.useState(takePolicyHandoff)
  React.useEffect(() => {
    // A rule handed over while this page is open may be new: reload to find it.
    const take = () => { const d = takePolicyHandoff(); if (d) { setPolicyHandoff(d); loadFleet() } }
    window.addEventListener(POLICY_HANDOFF, take)
    return () => window.removeEventListener(POLICY_HANDOFF, take)
  }, [loadFleet])
  React.useEffect(() => {
    if (policyHandoff?.new) setPolicyEditor({ initial: newPolicy({ appliesTo: { everyone: false, groups: [], sandboxes: [], ...policyHandoff.new.appliesTo } }) })
  }, [policyHandoff])
  const handedOff = React.useRef(null)
  React.useEffect(() => {
    if (!policyHandoff?.edit || !org || handedOff.current === policyHandoff) return
    const policy = org.policies.find((p) => p.id === policyHandoff.edit)
    if (policy) { handedOff.current = policyHandoff; setPolicyEditor({ initial: policy }) }
  }, [policyHandoff, org])

  // The box graph hands over one blocked host to allow: open its rule, pre-filled.
  React.useEffect(() => {
    let d = null
    try { d = JSON.parse(sessionStorage.getItem(ALLOW_HANDOFF) ?? "null"); sessionStorage.removeItem(ALLOW_HANDOFF) } catch { /* optional */ }
    if (!d?.sandbox || !d?.host) return
    setScope(d.sandbox)
    setEditor({ sandbox: d.sandbox, initial: ruleFor({ host: d.host, port: Number(d.port) || 443, programs: new Set(d.binary ? [d.binary] : []) }), after: () => setSignal((x) => x + 1) })
  }, [])

  const knownPrograms = React.useMemo(() => {
    const set = new Set()
    for (const e of live.events) if (e.binary) set.add(e.binary)
    return [...set].sort()
  }, [live.events])

  const open = (name) => { setScope(name); scroller.current?.scrollTo({ top: 0 }) }
  const openGlobal = () => { setShowGlobal(true); scroller.current?.scrollTo({ top: 0 }) }
  const back = () => { setScope(null); setShowGlobal(false); loadFleet(); scroller.current?.scrollTo({ top: 0 }) }

  // Allowing a blocked host is a new rule, pre-filled for where it was seen.
  function decide(kind, b) {
    const targetGroups = kind === "allow-one" ? groupFor(org, [...b.sandboxes][0]) : []
    const to = { everyone: false, groups: targetGroups, sandboxes: [] }
    if (kind.startsWith("allow")) { setPolicyEditor({ initial: newPolicy({ name: b.host, destinations: [b.host], appliesTo: to }) }); return }
    setPending({ kind, b })
  }

  function editPolicy(id) {
    const policy = (org?.policies ?? []).find((p) => p.id === id)
    if (policy) setPolicyEditor({ initial: policy })
  }

  function reportSync(result, what) {
    const applied = result.applied?.length ?? 0
    if (result.failed?.length) toast.warning(`${what}. ${plural(result.failed.length, "sandbox", "sandboxes")} could not be updated`, { description: result.failed.map((f) => `${f.sandbox}: ${f.error}`).join("\n") })
    else toast.success(what, { description: applied ? `Updated ${plural(applied, "sandbox", "sandboxes")}.` : undefined })
    loadFleet()
    setSignal((n) => n + 1)
  }

  async function clearBlocked() {
    setBusyBlocked(true)
    try {
      const current = org ?? (await api.org())
      reportSync(await api.saveOrg({ ...current.org, blocked: [] }), "Cleared blocked hosts")
      setClearingBlocked(false)
    } catch (e) { toast.error(e.message) } finally { setBusyBlocked(false) }
  }

  async function confirmDecision() {
    const { b } = pending
    try {
      const current = org ?? (await api.org())
      reportSync(await api.saveOrg({ ...current.org, blocked: [...current.org.blocked, b.host] }), `${b.host} blocked everywhere`)
      setPending(null)
    } catch (e) { toast.error(e.message) }
  }

  const total = fleet?.sandboxes?.length ?? 0

  return (
    <div ref={scroller} className="h-full overflow-y-auto">
      {showGlobal ? <GlobalPanel onBack={back} />
        : scope ? (
          <SandboxDetail key={scope} name={scope} sandbox={fleet?.sandboxes?.find((s) => s.name === scope) ?? live.sandboxes?.find((s) => s.name === scope)}
            events={live.events} onBack={back} onNavigate={onNavigate} onOpenGlobal={openGlobal} reloadSignal={signal}
            onDraft={(initial, after) => setEditor({ sandbox: scope, initial, after })} onEditPolicy={editPolicy} />
        ) : !fleet ? <p role="status" className="py-24 text-center text-sm text-muted-foreground">Loading…</p>
        : fleet.error ? <p role="alert" className="py-24 text-center text-sm text-muted-foreground">{fleet.error}</p>
        : <FleetSummary fleet={fleet} org={org} events={live.events} onOpen={open} onOpenGlobal={openGlobal} onDecide={decide} onNavigate={onNavigate} onRefresh={loadFleet}
            onEditPolicy={(p) => setPolicyEditor({ initial: p })} onEditBlocked={() => setEditingBlocked(true)} onClearBlocked={() => setClearingBlocked(true)}
            onAddPolicy={() => setPolicyEditor({ initial: newPolicy(forSandbox ? { appliesTo: { everyone: false, groups: groupFor(org, forSandbox), sandboxes: [] } } : {}) })}
            forSandbox={forSandbox} onClearSandbox={() => setForSandbox(null)} />}

      <PolicyDialog open={Boolean(policyEditor)} onOpenChange={(o) => { if (!o) setPolicyEditor(null) }} initial={policyEditor?.initial}
        groups={org?.groups ?? []} sandboxes={(fleet?.sandboxes ?? live.sandboxes ?? []).map((s) => s.name)} assignments={org?.assignments ?? {}} setupMembers={org?.setupMembers ?? {}} knownPrograms={knownPrograms}
        onGroupCreated={() => api.org().then(setOrg).catch(() => {})}
        onSaved={(result, policy) => reportSync(result, `${result.deleted ? "Deleted" : "Saved"} ${policy.name}`)} />
      <AlertDialog open={clearingBlocked} onOpenChange={(o) => { if (!o && !busyBlocked) setClearingBlocked(false) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unblock {plural(org?.org?.blocked?.length ?? 0, "host")} everywhere?</AlertDialogTitle>
            <AlertDialogDescription>Removes the shared blocked list and updates every sandbox. These hosts can then be reached if another rule allows them.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busyBlocked}>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={busyBlocked} onClick={clearBlocked}>{busyBlocked ? "Removing…" : "Unblock all"}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <BlockedHostsDialog open={editingBlocked} onOpenChange={setEditingBlocked} org={org?.org} onSaved={(result) => reportSync(result, "Saved blocked hosts")} />

      <RuleEditor open={Boolean(editor)} onOpenChange={(o) => { if (!o) setEditor(null) }} initial={editor?.initial} knownPrograms={knownPrograms}
        onSubmit={async (spec) => {
          const result = await api.applyOps(editor.sandbox, [{ kind: "addRule", rule: spec }])
          toast(`Saved as v${result.version}`)
          setSignal((n) => n + 1)
          editor.after?.(result.version)
        }} />

      <AlertDialog open={Boolean(pending)} onOpenChange={(o) => { if (!o) setPending(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Block {pending?.b.host} everywhere?</AlertDialogTitle>
            <AlertDialogDescription>
              Adds it, with its subdomains, to the hosts blocked in every sandbox. No rule can open it. Applies to {plural(total, "sandbox", "sandboxes")}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={confirmDecision}>Block everywhere</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
