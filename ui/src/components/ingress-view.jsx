import * as React from "react"
import { Check, Copy, DoorClosed, DoorOpen, ExternalLink, Globe, KeyRound, TerminalSquare, Timer, X } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Spinner } from "@/components/ui/spinner"
import { BlurFade } from "@/components/ui/blur-fade"
import { BorderBeam } from "@/components/ui/border-beam"
import { useApi, useLocation } from "@/lib/location-context"
import { useLive } from "@/lib/live"
import { relativeTime } from "@/lib/format"
import { styleOf } from "@/lib/sandboxes"

export const DURATIONS = [
  { minutes: 60, label: "1 hour" },
  { minutes: 480, label: "8 hours" },
  { minutes: 1440, label: "1 day" },
  { minutes: null, label: "Until I close it" },
]
const PRESETS = [
  { label: "Dev server", port: 3000, name: "dev" },
  { label: "Vite", port: 5173, name: "vite" },
  { label: "Jupyter", port: 8888, name: "jupyter" },
  { label: "Web app", port: 8080, name: "web" },
]

function remaining(iso, now) {
  const ms = Date.parse(iso) - now
  if (ms <= 0) return "closing…"
  const m = Math.round(ms / 60000)
  if (m < 60) return `${m}m`
  if (m < 48 * 60) return `${Math.floor(m / 60)}h ${m % 60 ? `${m % 60}m` : ""}`.trim()
  return `${Math.round(m / 1440)}d`
}

function useNow(interval = 30000) {
  const [now, setNow] = React.useState(Date.now())
  React.useEffect(() => { const t = setInterval(() => setNow(Date.now()), interval); return () => clearInterval(t) }, [interval])
  return now
}

function DurationPicker({ value, onChange, label = "Close automatically" }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex items-center gap-1 rounded-md border border-border p-0.5">
      {DURATIONS.map((d) => (
        <button key={String(d.minutes)} type="button" role="radio" aria-checked={value === d.minutes} onClick={() => onChange(d.minutes)}
          className={`flex-1 rounded px-2 py-1 text-[11px] whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${value === d.minutes ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
          {d.label}
        </button>
      ))}
    </div>
  )
}

function CopyButton({ text }) {
  const [done, setDone] = React.useState(false)
  return (
    <Button variant="ghost" size="icon-sm" aria-label="Copy URL" onClick={async () => { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500) }}>
      {done ? <Check className="size-3.5 text-emerald-600" /> : <Copy className="size-3.5" />}
    </Button>
  )
}

// One open door: the sentence first, the controls after it.
function ServiceDoor({ service, visits, now, onChanged, remote }) {
  const api = useApi()
  const [busy, setBusy] = React.useState(null)
  const [extending, setExtending] = React.useState(false)
  const label = service.name || "default"
  const failing = visits.filter((v) => v.verdict === "denied").length
  async function run(kind, fn, message) {
    setBusy(kind)
    try { await fn(); toast.success(message); onChanged() } catch (e) { toast.error(e.message) } finally { setBusy(null); setExtending(false) }
  }
  return (
    <div className="relative overflow-hidden rounded-lg border border-border bg-card">
      {service.expiresAt && Date.parse(service.expiresAt) - now < 15 * 60000 && <BorderBeam size={60} duration={8} colorFrom="#f59e0b" colorTo="#fde68a" />}
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <DoorOpen strokeWidth={1.4} className="size-4 text-emerald-600" aria-hidden="true" />
        <span className="font-mono text-[13px] font-medium">{label}</span>
        <span className="font-mono text-[11px] text-muted-foreground">→ port {service.port}</span>
        <span className="ml-auto flex items-center gap-1.5 text-[11px]">
          <Timer className={`size-3.5 ${service.expiresAt ? "text-amber-600" : "text-muted-foreground"}`} aria-hidden="true" />
          {service.expiresAt ? <span className="text-amber-800">closes in {remaining(service.expiresAt, now)}</span> : <span className="text-muted-foreground">no timer</span>}
        </span>
      </div>
      {remote && (
        <p className="border-t border-border/70 px-4 py-2 text-[11px] text-muted-foreground">Reachable by anyone with gateway access.</p>
      )}
      <div className="flex flex-wrap items-center gap-2 border-t border-border/70 px-4 py-2">
        {service.url ? (
          <>
            <a href={service.url} target="_blank" rel="noreferrer" className="min-w-0 truncate font-mono text-[11px] underline-offset-2 hover:underline">{service.url}</a>
            <CopyButton text={service.url} />
            <a href={service.url} target="_blank" rel="noreferrer" aria-label="Open in a new tab" className="rounded p-1 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"><ExternalLink className="size-3.5" /></a>
          </>
        ) : <span className="text-[11px] text-muted-foreground">No URL</span>}
        <span className="ml-auto font-mono text-[10px] text-muted-foreground" title="Visits recorded in the last hour">
          {visits.length} visit{visits.length === 1 ? "" : "s"}{failing ? <span className="text-red-600"> · {failing} failed</span> : null}
        </span>
      </div>
      {failing > 0 && visits[0]?.verdict === "denied" && (
        <p className="border-t border-border/70 bg-amber-50/50 px-4 py-1.5 text-[11px] text-amber-800">Last visit failed: nothing listening on port {service.port}.</p>
      )}
      <div className="flex flex-wrap items-center gap-2 border-t border-border/70 px-4 py-2">
        {extending ? (
          <>
            <div className="w-full sm:w-96"><DurationPicker value={undefined} onChange={(minutes) => run("extend", () => api.extendService(service, minutes), minutes ? "Timer reset" : "Timer removed")} label="New auto-close" /></div>
            <Button size="icon-xs" variant="ghost" onClick={() => setExtending(false)} aria-label="Cancel"><X /></Button>
          </>
        ) : (
          <Button size="xs" variant="ghost" onClick={() => setExtending(true)} disabled={Boolean(busy)}><Timer />Change timer</Button>
        )}
        <Button size="xs" variant="outline" className="ml-auto border-destructive/30 text-destructive hover:bg-destructive/5 hover:text-destructive" disabled={Boolean(busy)}
          onClick={() => run("close", () => api.closeService(service), `Closed ${label}`)}>
          {busy === "close" ? <Spinner /> : <DoorClosed />}Close now
        </Button>
      </div>
    </div>
  )
}

function OpenDoorForm({ sandbox, onOpened }) {
  const api = useApi()
  const [port, setPort] = React.useState("")
  const [name, setName] = React.useState("")
  const [minutes, setMinutes] = React.useState(60)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState(null)
  async function submit(event) {
    event.preventDefault()
    setBusy(true); setError(null)
    try {
      const r = await api.exposeService({ sandbox, name: name.trim(), port: Number(port), closeAfterMinutes: minutes })
      toast.success(`Opened ${name || "default"} on port ${port}`, { description: r.url ?? undefined })
      setPort(""); setName(""); onOpened()
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  return (
    <form onSubmit={submit} className="space-y-3 rounded-lg border border-dashed border-border p-4">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] font-medium">Open a port</span>
        {PRESETS.map((p) => (
          <button key={p.port} type="button" onClick={() => { setPort(String(p.port)); setName(p.name) }}
            className={`rounded border px-2 py-0.5 text-[11px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${port === String(p.port) ? "border-foreground/25 bg-accent" : "border-border text-muted-foreground hover:text-foreground"}`}>
            {p.label} <span className="font-mono opacity-60">{p.port}</span>
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid w-24 gap-1">
          <Label htmlFor="door-port" className="text-[11px] text-muted-foreground">Port</Label>
          <Input id="door-port" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))} className="h-8 font-mono text-xs" placeholder="3000" required inputMode="numeric" title="App must listen on 127.0.0.1" />
        </div>
        <div className="grid w-36 gap-1">
          <Label htmlFor="door-name" className="text-[11px] text-muted-foreground">Name</Label>
          <Input id="door-name" value={name} onChange={(e) => setName(e.target.value.toLowerCase())} className="h-8 font-mono text-xs" placeholder="default" />
        </div>
        <div className="min-w-72 flex-1">
          <span className="mb-1 block text-[11px] text-muted-foreground">Auto-close</span>
          <DurationPicker value={minutes} onChange={setMinutes} />
        </div>
        <Button type="submit" size="sm" disabled={busy || !port} className="bg-[var(--action)] text-[var(--action-foreground)] hover:bg-[var(--action)]/90">
          {busy ? <Spinner /> : <DoorOpen />}Open
        </Button>
      </div>
      {error && <p role="alert" className="rounded-md border border-red-200 bg-red-50/60 px-3 py-2 text-[11px] text-red-700">{error}</p>}
    </form>
  )
}

const INBOUND_LABEL = {
  visit: (e) => (e.verdict === "denied" ? `Visit to port ${e.port ?? "?"} failed` : `Visit to port ${e.port ?? "?"}`),
  session: () => "Terminal session opened",
  command: () => "Command run",
  "service-opened": (e) => `Opened ${e.service || "default"} → port ${e.port ?? "?"}`,
  "service-closed": (e) => `Closed ${e.service || "default"}`,
}

// A single visit logs an arrival and, when nothing answers, a failure a moment
// later. Show it once, as whatever it turned out to be.
function collapseVisits(events) {
  const out = []
  for (const e of events) {
    const prev = out[out.length - 1]
    if (prev && e.type === "visit" && prev.type === "visit" && prev.port === e.port && Math.abs(Date.parse(prev.at) - Date.parse(e.at)) < 2000) {
      if (e.verdict === "denied") out[out.length - 1] = e
      continue
    }
    out.push(e)
  }
  return out
}

export function IngressView() {
  const location = useLocation()
  return <ScopedIngressView key={location?.context ?? "default"} />
}

function ScopedIngressView() {
  const api = useApi()
  const location = useLocation()
  const scopeKey = location ? `ingress-scope:${location.context}` : "ingress-scope"
  const live = useLive()
  const now = useNow()
  const sandboxes = (live.sandboxes ?? []).filter((s) => s.phase !== "deleting")
  const [scope, setScope] = React.useState(() => { try { return sessionStorage.getItem(scopeKey) } catch { return null } })
  const selected = sandboxes.find((s) => s.name === scope)?.name ?? sandboxes[0]?.name ?? null
  React.useEffect(() => { try { if (selected) sessionStorage.setItem(scopeKey, selected) } catch { /* optional */ } }, [selected, scopeKey])

  const [data, setData] = React.useState(null)
  const load = React.useCallback(() => api.ingress().then(setData).catch((e) => setData({ error: e.message })), [api])
  React.useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t) }, [load])

  const services = (data?.services ?? []).filter((s) => s.sandbox === selected)
  const openBy = React.useMemo(() => {
    const out = {}
    for (const s of data?.services ?? []) out[s.sandbox] = (out[s.sandbox] ?? 0) + 1
    return out
  }, [data])
  const inbound = React.useMemo(() => collapseVisits(live.events.filter((e) => e.kind === "inbound" && e.sandbox === selected)), [live.events, selected])
  const visitsFor = (port) => inbound.filter((e) => e.type === "visit" && e.port === port && Date.parse(e.at) > now - 3600000)
  const sessions = inbound.filter((e) => e.type === "session" || e.type === "command")
  const ttl = data?.sessions?.ttlSeconds

  return (
    <div className="flex h-full min-h-0">
      <nav aria-label="Sandbox" className="hidden w-56 shrink-0 overflow-y-auto border-r border-border bg-background p-3 md:block">
        <p className="px-2 pb-2 text-[10px] font-bold tracking-widest text-faint uppercase">Sandboxes</p>
        {sandboxes.map((s) => (
          <button key={s.id} onClick={() => setScope(s.name)} aria-current={selected === s.name}
            className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${selected === s.name ? "bg-accent" : "hover:bg-muted/60"}`}>
            <span className={`size-2 shrink-0 rounded-[2px] ${styleOf(s.phase).cell}`} aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{s.name}</span>
            {openBy[s.name] ? <span className="rounded bg-emerald-50 px-1 font-mono text-[10px] text-emerald-800" title="Open services">{openBy[s.name]} open</span> : <span className="font-mono text-[10px] text-muted-foreground">closed</span>}
          </button>
        ))}
      </nav>

      <div className="min-w-0 flex-1 overflow-y-auto">
        {!selected ? <p className="py-16 text-center text-sm text-muted-foreground">No sandboxes yet.</p>
          : !data ? <p role="status" className="py-16 text-center text-sm text-muted-foreground">Loading…</p>
          : data.error ? <p role="alert" className="py-16 text-center text-sm text-muted-foreground">{data.error}</p>
          : (
            <div className="mx-auto grid max-w-6xl gap-6 px-4 py-5 sm:px-6 xl:grid-cols-[minmax(0,1fr)_17rem]">
              <div className="min-w-0 space-y-6">
                <select value={selected} onChange={(e) => setScope(e.target.value)} className="h-8 rounded-md border border-input bg-transparent px-2 font-mono text-xs md:hidden" aria-label="Sandbox">
                  {sandboxes.map((s) => <option key={s.id}>{s.name}</option>)}
                </select>

                <BlurFade duration={0.22} offset={3} blur="1px">
                  <div className={`rounded-lg border p-5 ${services.length ? "border-emerald-600/20 bg-emerald-50/40" : "border-border bg-card"}`}>
                    <p className="flex items-center gap-2 text-sm font-medium">
                      {services.length ? <DoorOpen className="size-4 text-emerald-600" /> : <DoorClosed className="size-4 text-muted-foreground" />}
                      {services.length ? `${services.length} service${services.length === 1 ? "" : "s"} open` : `${selected} is closed`}
                    </p>
                  </div>
                </BlurFade>

                <section className="space-y-3">
                  <h2 className="flex items-center gap-1.5 text-[10px] font-bold tracking-widest text-faint uppercase"><Globe className="size-3" />Web services</h2>
                  {services.map((s) => <ServiceDoor key={`${s.sandbox}/${s.name}`} remote={data.auth.remote} service={s} visits={visitsFor(s.port)} now={now} onChanged={() => { load(); live.refresh() }} />)}
                  <OpenDoorForm sandbox={selected} onOpened={() => { load(); live.refresh() }} />
                </section>

                <section className="space-y-2">
                  <h2 className="flex items-center gap-1.5 text-[10px] font-bold tracking-widest text-faint uppercase"><TerminalSquare className="size-3" />Terminal access</h2>
                  <div className="rounded-lg border border-border bg-card">
                    <p className="px-4 py-3 text-[11px] text-muted-foreground">
                      {ttl === null ? "Default session lifetime" : ttl === 0 ? "Sessions never expire" : `Sessions expire after ${Math.round(ttl / 60)} min`}
                    </p>
                    <div className="border-t border-border/70">
                      {sessions.length ? sessions.slice(0, 8).map((e) => (
                        <div key={`${e.at}|${e.message}`} className="flex h-[28px] items-center gap-3 border-b border-border/50 px-4 font-mono text-[11px] last:border-0">
                          <span className="w-16 shrink-0 text-muted-foreground">{new Date(e.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</span>
                          <span>{INBOUND_LABEL[e.type](e)}</span>
                        </div>
                      )) : <p className="px-4 py-2.5 text-[11px] text-muted-foreground">No recent sessions</p>}
                    </div>
                  </div>
                </section>
              </div>

              <aside className="space-y-4">
                <section className="rounded-lg border border-border bg-card p-4">
                  <h3 className="flex items-center gap-1.5 text-[10px] font-bold tracking-widest text-faint uppercase"><KeyRound className="size-3" />Access</h3>
                  <p className="mt-2 text-[11px] leading-relaxed">
                    {data.auth.mode === "mtls" ? "Client certificate (this Mac)" : `Sign-in: ${data.auth.mode}`}
                  </p>
                </section>
                <section>
                  <h3 className="mb-2 text-[10px] font-bold tracking-widest text-faint uppercase">Recent inbound</h3>
                  <ol className="rounded-lg border border-border bg-card">
                    {inbound.length ? inbound.slice(0, 14).map((e) => (
                      <li key={`${e.at}|${e.message}`} className="flex items-start gap-2 border-b border-border/50 px-3 py-1.5 text-[11px] last:border-0">
                        <span className={`mt-1.5 size-1.5 shrink-0 rounded-full ${e.verdict === "denied" ? "bg-red-500" : e.type.startsWith("service") ? "bg-emerald-500" : "bg-stone-400"}`} aria-hidden="true" />
                        <span className="min-w-0 flex-1">{INBOUND_LABEL[e.type]?.(e) ?? e.type}</span>
                        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{relativeTime(e.at)}</span>
                      </li>
                    )) : <li className="px-3 py-2 text-[11px] text-muted-foreground">Nothing yet.</li>}
                  </ol>
                </section>
              </aside>
            </div>
          )}
      </div>
    </div>
  )
}
