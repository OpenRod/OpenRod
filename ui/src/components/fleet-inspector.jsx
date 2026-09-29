import * as React from "react"
import { ArrowUpRight, Globe, KeyRound, Network, ShieldAlert, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { BorderBeam } from "@/components/ui/border-beam"
import { AuditLine } from "@/components/audit-line"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { agentsOf, agentInventoryLabel } from "@/lib/agents"
import { Perimeter } from "@/components/perimeter"
import { api } from "@/lib/api"
import { hostOf, isIp, portOf, sourceOf } from "@/lib/policy-sources"
import { rankHosts } from "@/lib/fleet"
import { PHASE_LABEL, commandText, imageName, statusOf, styleOf } from "@/lib/sandboxes"

const count = (n) => Intl.NumberFormat("en-US").format(n)
const remember = (key, value) => { try { sessionStorage.setItem(key, value) } catch { /* optional */ } }

// A split bar: how much of what a host (or a box) sent got through.
function Split({ allowed, denied, max }) {
  const total = allowed + denied
  const width = max ? Math.max(6, (total / max) * 100) : 100
  return (
    <span className="flex h-1.5 overflow-hidden rounded-full bg-muted" style={{ width: `${width}%` }} aria-hidden="true">
      <span className="h-full bg-stone-400" style={{ width: `${(allowed / Math.max(1, total)) * 100}%` }} />
      <span className="h-full bg-red-500" style={{ width: `${(denied / Math.max(1, total)) * 100}%` }} />
    </span>
  )
}

function Heading({ children, aside, icon: Icon }) {
  return (
    <h3 className="mb-2 flex items-center gap-1.5 text-[10px] font-bold tracking-widest text-faint uppercase">
      {Icon && <Icon className="size-3" aria-hidden="true" />}{children}
      {aside && <span className="ml-auto font-normal normal-case tracking-normal">{aside}</span>}
    </h3>
  )
}

// Nothing picked: the fleet as the gateway sees it - where traffic goes, and
// which credentials it carries. Picking a host lights up who talks to it.
export function FleetPanel({ traffic, focus, setFocus, providers, sandboxes }) {
  const [all, setAll] = React.useState(false)
  // Ranks shift with every decision; hold the order still under the pointer
  // so a row doesn't slide away from the click aimed at it.
  const [held, setHeld] = React.useState(null)
  const ranked = React.useMemo(() => {
    if (!held) return traffic.hosts
    const byHost = new Map(traffic.hosts.map((h) => [h.host, h]))
    return [...held.map((host) => byHost.get(host)).filter(Boolean), ...traffic.hosts.filter((h) => !held.includes(h.host))]
  }, [traffic.hosts, held])
  const hosts = all ? ranked : ranked.slice(0, 12)
  const max = traffic.hosts[0] ? traffic.hosts[0].allowed + traffic.hosts[0].denied : 1
  const attached = React.useMemo(() => {
    const out = {}
    for (const s of sandboxes) for (const p of s.providers) out[p] = (out[p] ?? 0) + 1
    return out
  }, [sandboxes])
  return (
    <div className="space-y-7 p-5">
      <section>
        <Heading icon={Globe} aside={<span className="font-mono text-[10px] text-muted-foreground">{count(traffic.hosts.length)} hosts</span>}>Destinations</Heading>
        {hosts.length ? (
          <ul className="-mx-2" onPointerEnter={() => setHeld(ranked.map((h) => h.host))} onPointerLeave={() => setHeld(null)}>
            {hosts.map((h) => {
              const active = focus?.type === "host" && focus.value === h.host
              return (
                <li key={h.host}>
                  <button onClick={() => setFocus(active ? null : { type: "host", value: h.host })} aria-pressed={active}
                    className={`grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 rounded-md px-2 py-1.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${active ? "bg-accent" : "hover:bg-muted/60"}`}>
                    <span className="flex min-w-0 items-center gap-1.5">
                      {h.denied > 0 && h.allowed === 0 && <ShieldAlert className="size-3 shrink-0 text-red-500" aria-label="Only denied" />}
                      <span className="truncate font-mono text-[11px]">{h.host}</span>
                    </span>
                    <span className="font-mono text-[10px] tabular-nums text-muted-foreground" title="Sandboxes that reached for it">{count(h.sandboxes.size)} box{h.sandboxes.size === 1 ? "" : "es"}</span>
                    <Split allowed={h.allowed} denied={h.denied} max={max} />
                    <span className="font-mono text-[10px] tabular-nums">
                      <span className="text-muted-foreground">{count(h.allowed)}</span>
                      {h.denied > 0 && <span className="text-red-600"> · {count(h.denied)}✕</span>}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        ) : <p className="text-[11px] text-muted-foreground">No connections yet</p>}
        {traffic.hosts.length > 12 && (
          <button onClick={() => setAll(!all)} className="mt-1 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
            {all ? "Top 12" : `All ${count(traffic.hosts.length)}`}
          </button>
        )}
      </section>

      <section>
        <Heading icon={KeyRound}>Providers</Heading>
        {providers.length ? (
          <ul className="-mx-2">
            {providers.map((p) => {
              const active = focus?.type === "provider" && focus.value === p.name
              return (
                <li key={p.name}>
                  <button onClick={() => setFocus(active ? null : { type: "provider", value: p.name })} aria-pressed={active}
                    className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${active ? "bg-accent" : "hover:bg-muted/60"}`}
                    title="Values never leave the gateway">
                    <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-[11px] font-medium">{p.name}</span>
                      <span className="block truncate font-mono text-[10px] text-muted-foreground">{p.type} · {p.credentialKeys.join(", ") || "no keys"}</span>
                    </span>
                    <span className="font-mono text-[10px] tabular-nums text-muted-foreground">{count(attached[p.name] ?? 0)}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        ) : <p className="text-[11px] text-muted-foreground">No providers</p>}
      </section>
    </div>
  )
}

// One box picked: everything the gateway knows about it, and what it has been
// asking the proxy for.
export function BoxPanel({ sandbox, stats, events, onOpen, onGraph, onClose, onNavigate }) {
  const hosts = stats ? rankHosts(stats.hosts) : []
  const max = hosts[0] ? hosts[0].allowed + hosts[0].denied : 1
  const recent = React.useMemo(() => events.filter((e) => e.sandbox === sandbox.name && e.kind === "audit" && e.verdict).slice(0, 10), [events, sandbox.name])
  const style = styleOf(sandbox.phase)
  return (
    <div className="space-y-6 p-5">
      <div className="relative overflow-hidden rounded-lg border border-border bg-card p-4">
        {statusOf(sandbox.phase) === "running" && <BorderBeam size={60} duration={7} colorFrom="#10b981" colorTo="#a7f3d0" />}
        <div className="flex items-start gap-2.5">
          <span className={`mt-1 size-3 shrink-0 rounded-[3px] ${style.cell}`} aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="truncate font-mono text-sm font-medium">{sandbox.name}</p>
            <p className="text-[11px] text-muted-foreground">{PHASE_LABEL[sandbox.phase]} · {imageName(sandbox.image, sandbox.imageTemplateName)}</p>
          </div>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Clear selection" className="-mt-1 -mr-1 text-muted-foreground"><X className="size-3.5" /></Button>
        </div>
        {sandbox.problem && statusOf(sandbox.phase) === "error" && (
          <p className="mt-3 rounded bg-red-50/70 px-2 py-1.5 font-mono text-[10px] leading-relaxed text-red-700">{sandbox.problem}</p>
        )}
        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3">
          {[
            ["Command", commandText(sandbox.command)],
            ["Providers", sandbox.providers.join(", ") || "None"],
            ["Policy", `v${sandbox.policyVersion ?? "-"}`],
          ].map(([label, value]) => (
            <div key={label} className="min-w-0">
              <dt className="text-[10px] text-muted-foreground">{label}</dt>
              <dd className="truncate font-mono text-[11px]" title={value}>{value}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-4 flex gap-2">
          <Button size="sm" onClick={onOpen} className="bg-[var(--action)] text-[var(--action-foreground)] hover:bg-[var(--action)]/90">
            Open<ArrowUpRight aria-hidden="true" />
          </Button>
          <Button size="sm" variant="outline" onClick={onGraph}><Network aria-hidden="true" />Graph</Button>
          <Button size="sm" variant="outline" onClick={() => { remember("egress-sandbox", sandbox.name); onNavigate("egress") }}>Rules</Button>
        </div>
      </div>


      <section>
        <Heading icon={Globe} aside={stats ? <span className="font-mono text-[10px] tabular-nums text-muted-foreground">{count(stats.allowed)}↑{stats.denied ? <span className="text-red-600"> {count(stats.denied)}✕</span> : null}</span> : null}>
          Through the gateway
        </Heading>
        {hosts.length ? (
          <ul className="space-y-2">
            {hosts.slice(0, 10).map((h) => (
              <li key={h.host} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1">
                <span className="truncate font-mono text-[11px]">{h.host}</span>
                <span className="font-mono text-[10px] tabular-nums text-muted-foreground">{count(h.allowed)}{h.denied ? <span className="text-red-600"> · {count(h.denied)}✕</span> : null}</span>
                <Split allowed={h.allowed} denied={h.denied} max={max} />
              </li>
            ))}
          </ul>
        ) : <p className="text-[11px] text-muted-foreground">Quiet lately</p>}
      </section>

      <section>
        <Heading>Recent decisions</Heading>
        {recent.length ? (
          <div className="overflow-hidden rounded-md border border-border bg-card">
            {recent.map((event) => <AuditLine key={`${event.at}|${event.message}`} event={event} dense />)}
          </div>
        ) : <p className="text-[11px] text-muted-foreground">None in the recent buffer</p>}
      </section>
    </div>
  )
}

// One box's perimeter, wide enough for the graph to draw: what its rules let
// out on the right, what the proxy refused on the left. Allowing a blocked host
// is a policy change, so it hands off to Egress rather than happening here.
export function PerimeterDialog({ sandbox, events, onClose, onNavigate }) {
  const [rules, setRules] = React.useState(null)
  const [inventory, setInventory] = React.useState(null)
  const name = sandbox?.name
  React.useEffect(() => {
    if (!name) { setRules(null); return }
    let cancelled = false
    let timer
    setRules(null); setInventory(null)
    const refresh = async () => {
      try {
        const d = await api.sandbox(name)
        if (!cancelled) { setRules(d.policy?.rules ?? []); setInventory(d.agentInventory) }
      } catch { if (!cancelled) { setRules([]); setInventory({ status: "unavailable" }) } }
      if (!cancelled) timer = setTimeout(refresh, 30000)
    }
    refresh()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [name, sandbox?.phase])

  const allowed = React.useMemo(() => {
    const seen = new Map()
    for (const rule of rules ?? []) for (const e of rule.endpoints) if (!e.blocked && !seen.has(e.host)) seen.set(e.host, { host: e.host, source: sourceOf(rule.key) })
    return [...seen.values()]
  }, [rules])
  const denied = React.useMemo(() => {
    const out = new Map()
    for (const e of events) {
      if (e.sandbox !== name || e.kind !== "audit" || e.verdict !== "denied") continue
      const host = hostOf(e.destination)
      if (!host || isIp(host)) continue
      const entry = out.get(host) ?? { host, port: portOf(e.destination), count: 0, binary: e.binary }
      entry.count += 1
      out.set(host, entry)
    }
    return [...out.values()].sort((a, b) => b.count - a.count)
  }, [events, name])

  return (
    <Dialog open={Boolean(sandbox)} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="font-mono">{name}</DialogTitle>
          <DialogDescription>What its rules let out, and what the gateway refused lately.</DialogDescription>
        </DialogHeader>
        {sandbox && (rules === null
          ? <p role="status" className="py-16 text-center text-sm text-muted-foreground">Reading policy…</p>
          : <Perimeter agents={agentsOf({ ...sandbox, agentInventory: inventory })} agentStatus={agentInventoryLabel({ agentInventory: inventory })} name={name} phase={sandbox.phase} allowed={allowed} denied={denied}
              onAllow={() => { remember("egress-sandbox", name); onClose(); onNavigate("egress") }} />)}
      </DialogContent>
    </Dialog>
  )
}
