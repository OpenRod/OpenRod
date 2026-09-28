import * as React from "react"
import { Inbox, Search } from "lucide-react"

import { BlurFade } from "@/components/ui/blur-fade"
import { Input } from "@/components/ui/input"
import { NumberTicker } from "@/components/ui/number-ticker"
import { ApprovalCard, DecisionRow } from "@/components/approval-card"
import { useLive } from "@/lib/live"

// Other pages open the inbox on one sandbox by writing its name here first.
export const APPROVALS_SCOPE = "approvals-scope"

function Stat({ label, value, dot }) {
  return (
    <div className="px-3 py-1.5">
      <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className={`size-1.5 rounded-full ${dot}`} aria-hidden="true" />{label}
      </span>
      <span className="mt-0.5 block font-mono text-lg leading-none tabular-nums"><NumberTicker value={value} /></span>
    </div>
  )
}

// Every sandbox that has a request or a decision, busiest first. Requests are
// reviewed one sandbox at a time: the rule an approval adds belongs to that
// sandbox alone, so a mixed list across the fleet would hide whose box it opens.
function useQueues(approvals, sandboxes) {
  return React.useMemo(() => {
    const map = new Map()
    const entry = (name) => {
      if (!map.has(name)) map.set(name, { name, pending: [], decided: [], lastSeenAt: null })
      return map.get(name)
    }
    for (const s of sandboxes) if (s.phase !== "deleting") entry(s.name)
    for (const c of approvals.pending) {
      const q = entry(c.sandbox)
      q.pending.push(c)
      const seen = c.lastSeenAt ?? c.createdAt ?? null
      if (seen && (!q.lastSeenAt || seen > q.lastSeenAt)) q.lastSeenAt = seen
    }
    for (const c of approvals.decided) entry(c.sandbox).decided.push(c)
    return [...map.values()].sort((a, b) =>
      b.pending.length - a.pending.length
      || (b.lastSeenAt ?? "").localeCompare(a.lastSeenAt ?? "")
      || a.name.localeCompare(b.name))
  }, [approvals, sandboxes])
}

function QueueRow({ queue, active, onSelect }) {
  const waiting = queue.pending.length
  return (
    <button onClick={onSelect} aria-current={active ? "true" : undefined}
      className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"}`}>
      <span className={`size-2 shrink-0 rounded-[2px] ${waiting ? "bg-amber-400" : "bg-stone-200"}`} aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className={`block truncate font-mono text-[12px] ${waiting ? "text-foreground" : ""}`}>{queue.name}</span>
      </span>
      <span className={`shrink-0 font-mono text-[11px] tabular-nums ${waiting ? "rounded bg-amber-100 px-1.5 text-amber-800" : "text-faint"}`}>
        {waiting}<span className="sr-only"> waiting</span>
      </span>
    </button>
  )
}

export function ApprovalsView() {
  const { approvals, sandboxes } = useLive()
  const queues = useQueues(approvals, sandboxes ?? [])
  const [query, setQuery] = React.useState("")
  const [scope, setScope] = React.useState(() => { try { return sessionStorage.getItem(APPROVALS_SCOPE) } catch { return null } })
  const selected = queues.find((q) => q.name === scope) ?? queues[0] ?? null
  React.useEffect(() => { try { if (selected) sessionStorage.setItem(APPROVALS_SCOPE, selected.name) } catch { /* optional */ } }, [selected?.name]) // eslint-disable-line react-hooks/exhaustive-deps

  const needle = query.trim().toLowerCase()
  const shown = needle ? queues.filter((q) => q.name.toLowerCase().includes(needle)) : queues
  const waiting = shown.filter((q) => q.pending.length)
  const clear = shown.filter((q) => !q.pending.length)
  const boxesWaiting = queues.filter((q) => q.pending.length).length
  const allowed = approvals.decided.filter((c) => c.status === "approved").length
  const blocked = approvals.decided.filter((c) => c.status === "rejected").length

  return (
    <div className="flex h-[calc(100svh-3.5rem)] min-h-0 flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2 border-b border-border px-4 pt-4 pb-3 sm:px-6">
        <Stat label="Waiting" value={approvals.pending.length} dot={approvals.pending.length ? "bg-amber-500" : "bg-stone-200"} />
        <Stat label="Sandboxes waiting" value={boxesWaiting} dot={boxesWaiting ? "bg-amber-500" : "bg-stone-200"} />
        <Stat label="Allowed" value={allowed} dot="bg-emerald-500" />
        <Stat label="Kept blocked" value={blocked} dot="bg-stone-400" />
      </div>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <nav aria-label="Sandboxes" className="flex max-h-56 shrink-0 flex-col border-b border-border md:max-h-none md:w-64 md:border-r md:border-b-0">
          <div className="relative p-2.5">
            <Search className="pointer-events-none absolute top-1/2 left-5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a sandbox" aria-label="Find a sandbox" className="h-8 pl-8 text-xs" />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-3">
            {waiting.length > 0 && (
              <>
                <h2 className="px-2.5 pt-1 pb-1.5 text-[10px] font-bold tracking-widest text-faint uppercase">Waiting</h2>
                {waiting.map((q) => <QueueRow key={q.name} queue={q} active={q.name === selected?.name} onSelect={() => setScope(q.name)} />)}
              </>
            )}
            {clear.length > 0 && (
              <>
                <h2 className="px-2.5 pt-3 pb-1.5 text-[10px] font-bold tracking-widest text-faint uppercase">Nothing waiting</h2>
                {clear.map((q) => <QueueRow key={q.name} queue={q} active={q.name === selected?.name} onSelect={() => setScope(q.name)} />)}
              </>
            )}
            {shown.length === 0 && <p className="px-2.5 py-4 text-xs text-muted-foreground">{needle ? "No sandbox matches." : "No sandboxes yet."}</p>}
          </div>
        </nav>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-4xl px-4 py-5 sm:px-6">
            {!approvals.loaded ? (
              <p role="status" className="py-16 text-center text-sm text-muted-foreground">Loading…</p>
            ) : !selected ? (
              <EmptyState title="No sandboxes" />
            ) : (
              <>
                <div className="mb-4 flex items-baseline gap-2">
                  <h2 className="truncate font-mono text-[15px] font-medium tracking-tight">{selected.name}</h2>
                  <span className="text-[11px] text-muted-foreground">{selected.pending.length ? `${selected.pending.length} waiting` : "all clear"}</span>
                </div>

                {selected.pending.length === 0 ? (
                  <EmptyState title="Nothing waiting" />
                ) : (
                  <div className="space-y-2.5">
                    {selected.pending.map((chunk, index) => (
                      <BlurFade key={chunk.id} delay={Math.min(index, 7) * 0.03} duration={0.22} offset={3} blur="1px">
                        <ApprovalCard chunk={chunk} highlight={index === 0} />
                      </BlurFade>
                    ))}
                  </div>
                )}

                {selected.decided.length > 0 && (
                  <section className="mt-10">
                    <h2 className="mb-2 text-[10px] font-bold tracking-widest text-faint uppercase">Decided</h2>
                    <div className="overflow-hidden rounded-lg border border-border bg-card">
                      {selected.decided.map((chunk) => <DecisionRow key={chunk.id} chunk={chunk} />)}
                    </div>
                  </section>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function EmptyState({ title }) {
  return (
    <div className="flex flex-col items-center py-14 text-center">
      <div className="flex size-10 items-center justify-center rounded-md border border-border/80 bg-linear-to-b from-background to-muted/60">
        <Inbox strokeWidth={1.3} className="size-5 text-muted-foreground" aria-hidden="true" />
      </div>
      <p className="mt-3 text-sm font-medium">{title}</p>
    </div>
  )
}
