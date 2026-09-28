import * as React from "react"
import { Pause, Play, Search, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { NumberTicker } from "@/components/ui/number-ticker"
import { AuditLine, reasonText } from "@/components/audit-line"
import { useVirtualRows } from "@/hooks/use-virtual-rows"
import { useLive } from "@/lib/live"

const VERDICTS = [
  { id: "all", label: "All" },
  { id: "denied", label: "Denied" },
  { id: "allowed", label: "Allowed" },
]
const ROW_HEIGHT = 30
// A refused DNS lookup reports "host", a refused connection "host:443"; they
// are the same destination to the person deciding whether to allow it.
const hostOf = (destination) => destination?.split("/")[0]?.replace(/:\d+$/, "") ?? null

function Toggle({ options, value, onChange, mono }) {
  return (
    <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
      {options.map((o) => (
        <button key={o.id ?? "all"} onClick={() => onChange(o.id)} aria-pressed={value === o.id}
          className={`rounded px-2.5 py-1 text-[11px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${mono ? "font-mono" : ""} ${value === o.id ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function ActivityView() {
  const live = useLive()
  const [verdict, setVerdict] = React.useState("all")
  const [sandbox, setSandbox] = React.useState(null)
  const [query, setQuery] = React.useState("")
  const [paused, setPaused] = React.useState(null)
  const [direction, setDirection] = React.useState("out")
  const events = paused ?? live.events
  // Outbound: what the sandbox reached for. Inbound: what reached into it.
  const audits = React.useMemo(() => events.filter((e) => (direction === "out" ? e.kind === "audit" : e.kind === "inbound") && e.verdict), [events, direction])
  const sandboxes = React.useMemo(() => [...new Set(audits.map((e) => e.sandbox))], [audits])

  const shown = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    return audits.filter((e) =>
      (verdict === "all" || e.verdict === verdict)
      && (!sandbox || e.sandbox === sandbox)
      && (!q || [e.destination, e.binary, e.detail, e.sandbox, e.reason].some((v) => v?.toLowerCase().includes(q))))
  }, [audits, verdict, sandbox, query])

  const scope = audits.filter((e) => !sandbox || e.sandbox === sandbox)
  const denied = scope.filter((e) => e.verdict === "denied")
  const topDenied = React.useMemo(() => {
    const counts = new Map()
    for (const e of denied) {
      const host = hostOf(e.destination)
      if (!host) continue
      const entry = counts.get(host) ?? { host, count: 0, reason: e.reason, program: e.binary }
      entry.count += 1
      counts.set(host, entry)
    }
    return [...counts.values()].sort((a, b) => b.count - a.count).slice(0, 6)
  }, [denied])

  const virtual = useVirtualRows({ count: shown.length, rowHeight: ROW_HEIGHT })
  const filtering = verdict !== "all" || sandbox || query

  return (
    <div className="flex h-[calc(100svh-3.5rem)] min-h-0 flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2 sm:px-6">
        <div className="relative mr-auto w-full sm:w-72">
          <Search className="absolute top-2.5 left-3 size-3.5 text-muted-foreground" aria-hidden="true" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} className="h-9 pl-9 text-xs" placeholder="Filter…" aria-label="Filter activity" />
        </div>
        <Toggle options={[{ id: "out", label: "Outbound" }, { id: "in", label: "Inbound" }]} value={direction} onChange={setDirection} />
        <Toggle options={VERDICTS} value={verdict} onChange={setVerdict} />
        {sandboxes.length > 1 && <Toggle mono options={[{ id: null, label: "All" }, ...sandboxes.map((s) => ({ id: s, label: s }))]} value={sandbox} onChange={setSandbox} />}
        {filtering && (
          <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => { setVerdict("all"); setSandbox(null); setQuery("") }}>
            <X className="size-3" />Clear
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={() => setPaused(paused ? null : live.events)} aria-pressed={Boolean(paused)}>
          {paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}{paused ? "Resume" : "Pause"}
        </Button>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="sticky top-0 z-10 flex h-8 shrink-0 items-center gap-3 border-b border-border bg-card px-4 font-mono text-[10px] font-bold tracking-widest text-faint uppercase">
            <span className="w-[4.5rem] shrink-0">Time</span>
            <span className="w-12 shrink-0">Verdict</span>
            <span className="hidden w-24 shrink-0 md:block">Sandbox</span>
            <span className="hidden w-20 shrink-0 lg:block">Program</span>
            <span className="min-w-0 flex-1">Destination</span>
            <span className="hidden w-56 shrink-0 text-right xl:block">Why</span>
          </div>
          <div ref={virtual.ref} onScroll={virtual.onScroll} className="min-h-0 flex-1 overflow-y-auto bg-card">
            {shown.length === 0 ? (
              <p className="py-16 text-center text-sm text-muted-foreground">{audits.length ? "No matches" : "No activity yet"}</p>
            ) : (
              <div style={{ height: virtual.totalHeight }} className="relative">
                <div style={{ transform: `translateY(${virtual.paddingTop}px)` }}>
                  {shown.slice(virtual.start, virtual.end).map((event) => (
                    <AuditLine key={`${event.sandbox}|${event.at}|${event.message}`} event={event} showSandbox />
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 border-t border-border bg-card px-4 py-1.5 text-[10px] text-muted-foreground sm:px-6">
            {paused ? <span className="text-amber-700">Paused</span> : (
              <span className="flex items-center gap-1.5">
                <span className="relative flex size-1.5"><span className="absolute inline-flex size-full rounded-full bg-emerald-400/55 motion-safe:animate-ping" /><span className="relative inline-flex size-1.5 rounded-full bg-emerald-500" /></span>
                Live
              </span>
            )}
            <span className="ml-auto font-mono tabular-nums">{shown.length} / {audits.length}</span>
          </div>
        </div>

        <aside className="hidden w-72 shrink-0 overflow-y-auto border-l border-border bg-background p-5 xl:block">
          <div className="flex gap-6">
            <div>
              <p className="text-[11px] text-muted-foreground">Allowed</p>
              <p className="font-mono text-lg tabular-nums"><NumberTicker value={scope.length - denied.length} /></p>
            </div>
            <div>
              <p className="text-[11px] text-muted-foreground">Denied</p>
              <p className="font-mono text-lg tabular-nums text-red-600"><NumberTicker value={denied.length} /></p>
            </div>
          </div>
          <h2 className="mt-6 mb-2 text-[10px] font-bold tracking-widest text-faint uppercase">Most denied</h2>
          {topDenied.length ? (
            <ul className="space-y-1.5">
              {topDenied.map((row) => (
                <li key={row.host}>
                  <button onClick={() => { setQuery(row.host); setVerdict("denied") }} title={reasonText(row.reason) ?? undefined}
                    className="group w-full rounded-md px-2 py-1.5 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring">
                    <span className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{row.host}</span>
                      <span className="font-mono text-[10px] tabular-nums text-red-600">{row.count}</span>
                    </span>
                    <span className="mt-0.5 block h-[3px] overflow-hidden rounded-full bg-muted">
                      <span className="block h-full rounded-full bg-red-400" style={{ width: `${(row.count / topDenied[0].count) * 100}%` }} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : <p className="text-[11px] text-muted-foreground">None</p>}
        </aside>
      </div>
    </div>
  )
}
