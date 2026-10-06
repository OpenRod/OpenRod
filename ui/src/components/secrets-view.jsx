import * as React from "react"
import { ArrowDown, ArrowUp, ArrowUpRight, CalendarClock, KeyRound, Link2, Plus, RefreshCw, Trash2, X } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Input } from "@/components/ui/input"
import { SearchInput } from "@/components/ui/search-input"
import { Label } from "@/components/ui/label"
import { Spinner } from "@/components/ui/spinner"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet"
import { useVirtualRows } from "@/hooks/use-virtual-rows"
import { indexSecrets, filterSecrets } from "@/lib/secret-inventory"
import { NumberTicker } from "@/components/ui/number-ticker"
import { useApi, useLocation } from "@/lib/location-context"
import { useLive } from "@/lib/live"
import { absoluteTime } from "@/lib/format"
import { serviceOf } from "@/lib/services"
import { AddSecretDialog } from "@/components/add-secret-dialog"
import { ServiceLogo } from "@/components/service-logo"
import { SelectField } from '@/components/ui/select-field'

const INJECTION = {
  header: (c) => `sent as the ${c.headerName ?? "custom"} header`,
  bearer: () => "sent as Authorization: Bearer",
  basic: () => "sent as HTTP basic auth",
  query: (c) => `sent as the ?${c.queryParam ?? "…"} parameter`,
  path: () => "placed in the request path",
}
const injection = (c) => (INJECTION[c.authStyle] ?? (() => "resolved by the proxy"))(c)
const soon = (iso) => iso && Date.parse(iso) - Date.now() < 7 * 86400000

// Masked, never echoed, cleared on close. Values go to the local console
// server once, which hands them to the gateway and keeps nothing.
function SecretField({ id, label, hint, value, onChange, required }) {
  return (
    <div className="grid gap-1">
      <Label htmlFor={id} className="font-mono text-[11px]">{label}{required && <span className="text-red-600"> *</span>}</Label>
      <Input id={id} type="password" value={value} onChange={(e) => onChange(e.target.value)} autoComplete="off" spellCheck={false}
        className="font-mono text-xs" placeholder="Paste the value" required={required} title={hint} />
    </div>
  )
}

function RotateDialog({ secret, onClose, onDone }) {
  const api = useApi()
  const [values, setValues] = React.useState({})
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState(null)
  React.useEffect(() => { setValues({}); setError(null) }, [secret])
  return (
    <Dialog open={Boolean(secret)} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="sm:max-w-md" aria-describedby={undefined}>
        <form autoComplete="off" className="grid gap-4" onSubmit={async (e) => {
          e.preventDefault(); setBusy(true); setError(null)
          try {
            const r = await api.rotateSecret(secret.name, values)
            setValues({})
            toast.success(`Rotated ${secret.name}`, { description: r.sandboxesNotified ? `${r.sandboxesNotified} sandbox${r.sandboxesNotified === 1 ? "" : "es"} updated` : undefined })
            onClose(); onDone()
          } catch (err) { setError(err.message) } finally { setBusy(false) }
        }}>
          <DialogHeader>
            <DialogTitle>Rotate {secret?.name}</DialogTitle>
          </DialogHeader>
          {secret?.credentialKeys.map((key) => (
            <SecretField key={key} id={`rot-${key}`} label={key} value={values[key] ?? ""} onChange={(v) => setValues((cur) => ({ ...cur, [key]: v }))} />
          ))}
          {error && <p role="alert" className="rounded-md border border-red-200 bg-red-50/60 px-3 py-2 text-[11px] text-red-700">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={busy || !Object.values(values).some(Boolean)} className="bg-[var(--action)] text-[var(--action-foreground)] hover:bg-[var(--action)]/90">{busy && <Spinner aria-hidden="true" />}Rotate</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function ExpiryControl({ secret, keyName, onDone }) {
  const api = useApi()
  const current = secret.expires?.[keyName]
  const [editing, setEditing] = React.useState(false)
  const [date, setDate] = React.useState("")
  if (!editing) {
    return (
      <button onClick={() => { setDate(current ? current.slice(0, 10) : ""); setEditing(true) }}
        className={`flex items-center gap-1 text-[11px] outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring ${soon(current) ? "text-amber-700" : "text-muted-foreground"}`}>
        <CalendarClock className="size-3" />{current ? `expires ${absoluteTime(current)}` : "no expiry"}
      </button>
    )
  }
  return (
    <span className="flex items-center gap-1.5">
      <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="h-7 w-36 text-[11px]" aria-label={`Expiry for ${keyName}`} />
      <Button size="xs" variant="outline" onClick={async () => {
        try { await api.secretExpiry(secret.name, keyName, date ? new Date(`${date}T23:59:00`).toISOString() : null); toast.success(date ? "Expiry set" : "Expiry cleared"); setEditing(false); onDone() } catch (e) { toast.error(e.message) }
      }}>Save</Button>
      {current && <Button size="xs" variant="ghost" onClick={async () => { try { await api.secretExpiry(secret.name, keyName, null); setEditing(false); onDone() } catch (e) { toast.error(e.message) } }}>Clear</Button>}
      <Button size="icon-xs" variant="ghost" onClick={() => setEditing(false)} aria-label="Cancel"><X /></Button>
    </span>
  )
}

function SecretDetails({ secret, profile, sandboxes, onRotate, onDelete, onDone }) {
  const api = useApi()
  const [busy, setBusy] = React.useState(false)
  const free = sandboxes.filter((s) => !secret.attachedTo.includes(s.name))
  async function attach(sandbox, on) {
    setBusy(true)
    try { await api.attachSecret(secret.name, sandbox, on); toast.success(on ? `Attached to ${sandbox}` : `Detached from ${sandbox}`); onDone() }
    catch (e) { toast.error(e.message) } finally { setBusy(false) }
  }
  return (
    <div className="bg-card">
      <div className="flex flex-wrap items-center gap-2 border-b border-border/70 px-4 py-3">
        <ServiceLogo type={secret.type} />
        <div className="min-w-0">
          <p className="truncate font-mono text-[13px] font-medium">{secret.name}</p>
          <p className="text-[11px] text-muted-foreground">{serviceOf(secret.type)?.name ?? profile?.name ?? secret.type}</p>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          {secret.credentialKeys.length > 0 && <Button size="sm" variant="outline" onClick={onRotate}><RefreshCw />Rotate</Button>}
          <Button size="icon-sm" variant="ghost" className="text-muted-foreground hover:text-destructive" onClick={onDelete} aria-label={`Delete ${secret.name}`}><Trash2 className="size-3.5" /></Button>
        </div>
      </div>
      <div className="grid gap-4 px-4 py-3 ">
        <div className="space-y-1.5">
          <h4 className="text-[10px] font-bold tracking-widest text-faint uppercase">Credentials</h4>
          {secret.credentialKeys.length === 0 && <p className="text-[11px] text-muted-foreground">None. Access only.</p>}
          {secret.credentialKeys.map((key) => {
            const def = profile?.credentials.find((c) => c.envVars.includes(key))
            return (
              <div key={key} className="space-y-0.5">
                <p className="flex items-center gap-1.5 font-mono text-[11px]" title={def ? injection(def) : undefined}><span className="size-1.5 rounded-full bg-emerald-500" aria-hidden="true" />{key}</p>
                <div className="pl-3"><ExpiryControl secret={secret} keyName={key} onDone={onDone} /></div>
              </div>
            )
          })}
        </div>
        <div className="space-y-1.5">
          <h4 className="text-[10px] font-bold tracking-widest text-faint uppercase">Allowed hosts</h4>
          {profile ? (
            <>
              <ul className="space-y-0.5 font-mono text-[11px]">
                {profile.endpoints.map((e) => <li key={`${e.host}:${e.port}`}>{e.host}{e.port ? `:${e.port}` : ""}<span className="font-sans text-[10px] text-muted-foreground"> {e.access ?? ""}</span></li>)}
              </ul>
              <p className="text-[10px] text-muted-foreground">by {profile.binaries.map((b) => b.split("/").pop()).filter((v, i, a) => a.indexOf(v) === i).join(", ") || "any program"}</p>
            </>
          ) : <p className="text-[11px] text-muted-foreground">Profile not found.</p>}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 border-t border-border/70 px-4 py-2.5 text-[11px]">
        <Link2 className="size-3 text-muted-foreground" aria-hidden="true" />
        <span className="text-muted-foreground">Attached to</span>
        {secret.attachedTo.map((s) => (
          <span key={s} className="flex items-center gap-0.5 rounded bg-muted py-0.5 pr-0.5 pl-1.5 font-mono text-[10px]">
            {s}
            <button onClick={() => attach(s, false)} disabled={busy} aria-label={`Detach from ${s}`} className="rounded p-0.5 text-muted-foreground outline-none hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring"><X className="size-2.5" /></button>
          </span>
        ))}
        {!secret.attachedTo.length && <span className="text-muted-foreground/70">no sandbox</span>}
        {free.length > 0 && (
          <SelectField value="" disabled={busy} onChange={(e) => e.target.value && attach(e.target.value, true)} aria-label="Attach to a sandbox"
            className="ml-auto h-7 rounded-md border border-input bg-transparent px-1.5 text-[11px] text-muted-foreground">
            <option value="">Attach to…</option>
            {free.map((s) => <option key={s.id} value={s.name}>{s.name}</option>)}
          </SelectField>
        )}
        {busy && <Spinner className="size-3" />}
      </div>
    </div>
  )
}

import { LocationProvider } from '@/lib/location-context'
import { PlacementBadge } from '@/components/placement-badge'
import { LocationAction } from '@/components/location-action'
import { useLocationData } from '@/lib/location-data'
import { resourceKey } from '@/lib/locations'

const EMPTY = []
const COLUMNS = [
  { id: "name", label: "Secret", width: "22%" }, { id: "source", label: "Source", width: "10%" }, { id: "service", label: "Service", width: "14%" },
  { id: "credentials", label: "Credentials", width: "12%" }, { id: "attached", label: "Sandboxes", width: "14%" },
  { id: "expiry", label: "Next expiry", width: "12%" }, { id: "hosts", label: "Allowed hosts", width: "12%" },
]
const EXPIRY_LABEL = { none: "No expiry", expired: "Expired", expiring: "Within 7 days", scheduled: "Scheduled" }

function CombinedSecretsView() {
  const model = useLocationData(['secrets'])
  return <ScopedSecretsView model={model} />
}
export function SecretsView({combined}) {
  const location = useLocation()
  if(combined)return <CombinedSecretsView />
  return <ScopedSecretsView key={location?.id ?? location?.context ?? "default"} />
}

function ScopedSecretsView({model}) {
  const api = useApi()
  const location = useLocation()
  const live = useLive()
  const [singleData, setData] = React.useState(null)
  const data = model ? (model.loading && !model.sources.length ? null : {providers:EMPTY,profiles:EMPTY,sources:model.sources}) : singleData
  const [error, setError] = React.useState(null)
  const [loading, setLoading] = React.useState(false)
  const [adding, setAdding] = React.useState(false)
  const [rotating, setRotating] = React.useState(null)
  const [deleting, setDeleting] = React.useState(null)
  const [opened, setOpened] = React.useState(null)
  const [query, setQuery] = React.useState("")
  const [scope, setScope] = React.useState("all")
  const [service, setService] = React.useState("")
  const [expiry, setExpiry] = React.useState("")
  const [sort, setSort] = React.useState({ key: "name", direction: "asc" })
  const [now, setNow] = React.useState(Date.now)
  const search = React.useRef(null)
  const deferredQuery = React.useDeferredValue(query)
  const load = React.useCallback(async () => {
    setLoading(true)
    try { const d = model ? await model.refresh() : await api.secrets(); if(!model)setData(d); setError(null); return d }
    catch (e) { setError(e.message); return null }
    finally { setLoading(false) }
  }, [api, model?.refresh])
  React.useEffect(() => { load() }, [load])
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60000)
    const onKey = (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k" && !opened && !adding && !rotating && !deleting) { e.preventDefault(); search.current?.focus() } }
    window.addEventListener("keydown", onKey)
    return () => { clearInterval(timer); window.removeEventListener("keydown", onKey) }
  }, [opened, adding, rotating, deleting])
  const providers = data?.providers ?? EMPTY
  const profiles = data?.profiles ?? EMPTY
  const rows = React.useMemo(() => model ? model.sources.flatMap(source=>indexSecrets(source.data?.secrets?.providers ?? [],source.data?.secrets?.profiles ?? [],now).map(row=>({...row,secret:{...row.secret,location:source.location}}))) : indexSecrets(providers, profiles, now), [providers, profiles, now, model?.sources])
  const ordered = React.useMemo(() => filterSecrets(rows, { query: deferredQuery, scope, service, expiry, sort }), [rows, deferredQuery, scope, service, expiry, sort])
  const services = React.useMemo(() => [...new Map(rows.map((row) => [row.secret.type, row.service])).entries()].sort((a, b) => a[1].localeCompare(b[1])), [rows])
  const virtual = useVirtualRows({ count: ordered.length, rowHeight: 40 })
  React.useEffect(() => { virtual.scrollToTop() }, [deferredQuery, scope, service, expiry, sort])
  const selected = rows.find((row) => resourceKey(row.secret) === opened)
  const sandboxes = (model ? model.inventory.sandboxes : live.sandboxes ?? []).filter((s) => s.phase !== "deleting")
  const attached = rows.filter((row) => row.secret.attachedTo.length > 0).length
  const expiring = rows.filter((row) => row.status === "expiring").length
  const expired = rows.filter((row) => row.status === "expired").length
  const filtering = query || scope !== "all" || service || expiry
  const clear = () => { setQuery(""); setScope("all"); setService(""); setExpiry("") }
  const refresh = () => { load(); live.refresh() }
  const cell = "h-10 border-b border-border/60 px-4 py-0 align-middle text-muted-foreground"

  return (
    <>
    <div className="flex h-[calc(100svh-3.5rem)] min-h-0 flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-1 border-b border-border px-4 pt-4 pb-3 sm:px-6" role="group" aria-label="Secret inventory summary">
        {[['all', 'Secrets', rows.length], ['attached', 'Attached', attached], ['unattached', 'Unattached', rows.length - attached]].map(([id, label, count]) => (
          <button key={id} aria-pressed={scope === id} onClick={() => setScope(id)} className={`rounded-md px-3 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring ${scope === id ? "bg-accent/70" : "hover:bg-muted/60"}`}>
            <span className="text-[11px] text-muted-foreground">{label}</span><span className="mt-1 block font-mono text-lg leading-none tabular-nums"><NumberTicker value={count} /></span>
          </button>
        ))}
        <div className="ml-auto flex gap-1">
          {[["expiring", "Expiring in 7 days", expiring], ["expired", "Expired", expired]].map(([id, label, count]) => <button key={id} aria-pressed={expiry === id} onClick={() => setExpiry(expiry === id ? "" : id)} className={`rounded-md px-3 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring ${expiry === id ? "bg-accent/70" : "hover:bg-muted/60"}`}><span className="text-[11px] text-muted-foreground">{label}</span><span className={`mt-1 block font-mono text-lg leading-none tabular-nums ${count ? id === "expired" ? "text-red-600" : "text-amber-700" : "text-muted-foreground"}`}><NumberTicker value={count} /></span></button>)}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2 sm:px-6">
        <SearchInput ref={search} value={query} onValueChange={setQuery} placeholder="Search name, sandbox, host…" aria-label="Search secrets" className="mr-auto w-full sm:w-72" />
        <SelectField aria-label="Filter by service" value={service} onChange={(e) => setService(e.target.value)} className="h-8 max-w-44 rounded-md border border-border bg-card px-2 text-xs"><option value="">All services</option>{services.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</SelectField>
        <SelectField aria-label="Filter by expiry" value={expiry} onChange={(e) => setExpiry(e.target.value)} className="h-8 rounded-md border border-border bg-card px-2 text-xs"><option value="">Any expiry</option>{Object.entries(EXPIRY_LABEL).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</SelectField>
        {filtering && <Button variant="ghost" size="sm" onClick={clear}><X />Clear</Button>}
        <Button variant="ghost" size="icon-sm" aria-label="Refresh secrets" disabled={loading} onClick={refresh}><RefreshCw className={loading ? "animate-spin" : ""} /></Button>
        <Button size="sm" disabled={!data} onClick={() => setAdding(true)} className="bg-[var(--action)] text-[var(--action-foreground)] hover:bg-[var(--action)]/90"><Plus />Add secret</Button>
      </div>
      {error && <div role="alert" className="flex items-center gap-3 border-b border-border px-6 py-2 text-xs text-red-600"><span>{data ? "Could not refresh. Showing the last reading. " : ""}{error}</span><Button variant="outline" size="sm" onClick={load}>Retry</Button></div>}
      <div ref={virtual.ref} onScroll={virtual.onScroll} tabIndex={0} role="region" aria-label="Secret inventory" className="min-h-0 flex-1 overflow-auto overscroll-contain outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
        {!data && !error ? <p role="status" className="py-20 text-center text-sm text-muted-foreground">Loading secrets…</p> : !ordered.length ? <div className="py-20 text-center"><KeyRound className="mx-auto mb-3 size-6 text-muted-foreground" /><p className="text-sm">{error && !data ? "Secrets unavailable" : rows.length ? "No matching secrets" : "No secrets yet"}</p>{data && <Button variant="outline" className="mt-4" onClick={rows.length ? clear : () => setAdding(true)}>{rows.length ? "Clear filters" : "Add secret"}</Button>}</div> :
          <table aria-label="Secrets" aria-rowcount={ordered.length + 1} className="w-full min-w-[900px] table-fixed border-separate border-spacing-0 text-xs">
            <colgroup>{COLUMNS.map((c) => <col key={c.id} style={{ width: c.width }} />)}</colgroup>
            <thead className="sticky top-0 z-10 bg-muted"><tr aria-rowindex={1}>{COLUMNS.map((c) => <th key={c.id} scope="col" aria-sort={sort.key === c.id ? sort.direction === "asc" ? "ascending" : "descending" : "none"} className="h-9 border-b border-border px-4 text-left font-medium text-muted-foreground first:pl-6">{["hosts","source"].includes(c.id) ? c.label : <button className="flex h-9 w-full items-center gap-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setSort({ key: c.id, direction: sort.key === c.id && sort.direction === "asc" ? "desc" : "asc" })}>{c.label}{sort.key === c.id && (sort.direction === "asc" ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}</button>}</th>)}</tr></thead>
            <tbody>
              {virtual.paddingTop > 0 && <tr aria-hidden="true"><td colSpan={COLUMNS.length} style={{ height: virtual.paddingTop, padding: 0 }} /></tr>}
              {ordered.slice(virtual.start, virtual.end).map((row, i) => <tr key={resourceKey(row.secret)} aria-rowindex={virtual.start + i + 2} onClick={() => { if(row.secret.location?.connected !== false)setOpened(resourceKey(row.secret)) }} className="group cursor-pointer bg-card hover:bg-muted/60 focus-within:bg-muted/60">
                <td className={`${cell} pl-6`}><button disabled={row.secret.location?.connected === false} aria-haspopup="dialog" aria-label={`Open ${row.secret.name}`} className="flex h-9 w-full items-center gap-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={(e) => { e.stopPropagation(); setOpened(resourceKey(row.secret)) }}><ServiceLogo type={row.secret.type} size="sm" /><span title={row.secret.name} className="truncate font-medium text-foreground">{row.secret.name}</span><ArrowUpRight className="ml-auto size-3 shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100" /></button></td>
                <td className={cell}><PlacementBadge location={row.secret.location ?? location} /></td>
                <td className={cell}><span className="block truncate" title={row.service}>{row.service}</span></td>
                <td className={cell}><span className="font-mono text-[11px]">{row.secret.credentialKeys.length || "Access only"}</span></td>
                <td className={cell}><span className="block truncate" title={row.secret.attachedTo.slice(0, 10).join(", ")}>{row.secret.attachedTo.length === 1 ? row.secret.attachedTo[0] : row.secret.attachedTo.length ? `${row.secret.attachedTo.length.toLocaleString()} sandboxes` : "Unattached"}</span></td>
                <td className={cell}><span className={row.status === "expired" ? "text-red-600" : row.status === "expiring" ? "text-amber-700" : ""} title={row.expiry ? new Date(row.expiry).toLocaleString() : undefined}>{row.status === "expired" ? "Expired · " : ""}{row.expiry ? new Date(row.expiry).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "No expiry"}</span></td>
                <td className={cell}><span className="block truncate font-mono text-[11px]" title={row.hosts.join(", ")}>{row.hosts.length === 1 ? row.hosts[0] : row.hosts.length ? `${row.hosts.length} hosts` : "-"}</span></td>
              </tr>)}
              {virtual.end < ordered.length && <tr aria-hidden="true"><td colSpan={COLUMNS.length} style={{ height: (ordered.length - virtual.end) * 40, padding: 0 }} /></tr>}
            </tbody>
          </table>}
      </div>
      <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border bg-card px-6 py-2 text-[11px] text-muted-foreground"><span><strong className="font-medium text-foreground">{ordered.length.toLocaleString()}</strong>{filtering ? ` of ${rows.length.toLocaleString()}` : ""} secrets</span><span className="hidden sm:inline">Click a row to inspect · ⌘K to search</span></div>
    </div>
    <Sheet open={Boolean(selected)} onOpenChange={(open) => { if (!open) setOpened(null) }}>
      <SheetContent className="w-full gap-0 sm:max-w-lg" aria-describedby="secret-description">
        <SheetHeader className="border-b border-border px-4 py-4 pr-12"><SheetTitle>Secret details</SheetTitle><SheetDescription id="secret-description" className="text-xs">Manage credentials, expiry, and sandbox access.</SheetDescription></SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">{selected && <LocationProvider location={selected.secret.location ?? location}><SecretDetails key={resourceKey(selected.secret)} secret={selected.secret} profile={selected.profile} sandboxes={sandboxes.filter(item=>!model || item.location?.id===selected.secret.location?.id)} onRotate={() => setRotating(selected.secret)} onDelete={() => setDeleting(selected.secret)} onDone={refresh} /></LocationProvider>}</div>
      </SheetContent>
    </Sheet>
      {!model && <AddSecretDialog open={adding} onOpenChange={setAdding} profiles={profiles} providers={providers} sandboxes={sandboxes}
        reload={async () => { const d = await load(); live.refresh(); return d }} />}
      {model && adding && <LocationAction onClose={()=>setAdding(false)}>{(destination,onClose)=><AddSecretAtLocation model={model} location={destination} onClose={onClose} />}</LocationAction>}
      <LocationProvider location={rotating?.location ?? location}><RotateDialog secret={rotating} onClose={() => setRotating(null)} onDone={refresh} /></LocationProvider>
      <AlertDialog open={Boolean(deleting)} onOpenChange={(open) => { if (!open) setDeleting(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting?.attachedTo.length
                ? `Detach from ${deleting.attachedTo.join(", ")} first.`
                : "This cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={Boolean(deleting?.attachedTo.length)} onClick={async () => {
              try { await (model ? model.apiFor(deleting.location) : api).deleteSecret(deleting.name); toast.success(`Deleted ${deleting.name}`); refresh() } catch (e) { toast.error(e.message) } finally { setDeleting(null) }
            }}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function AddSecretAtLocation({model,location,onClose}) {
  const api=useApi()
  const [data,setData]=React.useState(null)
  const [error,setError]=React.useState(null)
  React.useEffect(()=>{let alive=true;api.secrets().then(value=>{if(alive)setData(value)}).catch(e=>{if(alive)setError(e.message)});return()=>{alive=false}},[api])
  if(!data)return <Dialog open onOpenChange={open=>{if(!open)onClose()}}><DialogContent><DialogHeader><DialogTitle>Add secret</DialogTitle><DialogDescription>{error || "Loading credentials…"}</DialogDescription></DialogHeader></DialogContent></Dialog>
  return <AddSecretDialog open onOpenChange={open=>{if(!open)onClose()}} profiles={data?.profiles ?? []} providers={data?.providers ?? []}
    sandboxes={model.inventory.sandboxes.filter(item=>item.location.id===location.id)} reload={async()=>{const result=await api.secrets();model.refresh();return result}} />
}
