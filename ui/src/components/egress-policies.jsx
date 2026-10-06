import * as React from "react"
import { AlertTriangle, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { RequestList, Segmented } from "@/components/rule-editor"
import { groupFor } from "@/lib/groups"
import { GroupPicker } from "@/components/group-picker"
import { useApi } from "@/lib/location-context"
import { appliesTo as reaches } from "@/lib/egress"
import { cn } from "@/lib/utils"

export { appliesTo, blockPatterns } from "@/lib/egress"

// A network rule: a name, destinations and an action. Everything else is
// Advanced, with defaults that mean "any request from any program on the web
// ports". The server compiles each one into OpenShell rules (server/egress.js).

export const DEFAULT_ADVANCED = { ports: [443, 80], programs: [], requests: "any", allow: [], deny: [], enforcement: "enforce", privateIps: [] }
const REQUESTS = [
  { id: "any", label: "Any", hint: "Every method and path" },
  { id: "read-only", label: "Read only", hint: "GET, HEAD and OPTIONS" },
  { id: "read-write", label: "Read & write", hint: "Adds POST, PUT and PATCH" },
  { id: "custom", label: "Specific", hint: "Only the method and path pairs listed" },
]

export const POLICY_PRESETS = [
  { label: "GitHub · read and clone", policy: { name: "GitHub read", destinations: ["github.com", "api.github.com", "codeload.github.com"],
    advanced: { ...DEFAULT_ADVANCED, ports: [443], requests: "custom",
      // git clone and fetch POST to git-upload-pack; a push POSTs to git-receive-pack.
      allow: [{ method: "GET", path: "/**" }, { method: "HEAD", path: "/**" }, { method: "POST", path: "/*/*/git-upload-pack" }],
      deny: [{ method: "*", path: "/*/*/git-receive-pack" }] } } },
  { label: "npm", policy: { name: "npm registry", destinations: ["registry.npmjs.org"], advanced: { ...DEFAULT_ADVANCED, ports: [443] } } },
  { label: "PyPI", policy: { name: "PyPI", destinations: ["pypi.org", "files.pythonhosted.org"], advanced: { ...DEFAULT_ADVANCED, ports: [443], requests: "read-only" } } },
]

export const newPolicy = (over = {}) => ({ name: "", action: "allow", destinations: [], appliesTo: { everyone: false, groups: [], sandboxes: [] }, advanced: DEFAULT_ADVANCED, ...over })

const lines = (text) => text.split("\n").map((s) => s.trim()).filter(Boolean)
const split = (text) => text.split(/[\s,]+/).filter(Boolean)
const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40).replace(/-$/, "")
const joinAnd = (items) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`)
const isDefault = (a) => JSON.stringify({ ...DEFAULT_ADVANCED, ...a }) === JSON.stringify(DEFAULT_ADVANCED)

function toForm(p) {
  const a = { ...DEFAULT_ADVANCED, ...(p?.advanced ?? {}) }
  return {
    id: p?.id ?? "", name: p?.name ?? "", action: p?.action ?? "allow", setup: p?.setup ?? null,
    destinations: [...(p?.destinations ?? [])],
    appliesTo: { everyone: false, groups: [], sandboxes: [], ...(p?.appliesTo ?? {}) },
    ports: a.ports.join(", "), programs: [...a.programs], requests: a.requests, allow: [...a.allow], deny: [...a.deny], enforcement: a.enforcement, privateIps: a.privateIps.join(", "),
  }
}

function toPolicy(f, isNew) {
  return {
    id: isNew ? slug(f.name) : f.id, name: f.name.trim(), action: f.action, destinations: f.destinations, appliesTo: f.appliesTo,
    // An MCPs & Skills setup's own policy keeps its marker, so the setup still finds it.
    ...(f.setup ? { setup: f.setup } : {}),
    ...(f.action === "allow" ? { advanced: {
      ports: split(f.ports).map(Number), programs: f.programs, requests: f.requests,
      allow: f.requests === "custom" ? f.allow.filter((r) => r.path) : [], deny: f.deny.filter((r) => r.path),
      enforcement: f.enforcement, privateIps: split(f.privateIps),
    } } : {}),
  }
}

const setupName = (p) => p.setup?.name ?? "an MCPs & Skills setup"

export function appliesToText(p, groups) {
  const to = p.appliesTo
  if (to.everyone) return "every sandbox"
  const names = [...to.groups.map((id) => groups.find((g) => g.id === id)?.name ?? id), ...to.sandboxes, ...(to.setups?.length ? [`sandboxes using “${setupName(p)}”`] : [])]
  return names.length ? joinAnd(names) : null
}

// The policy in one sentence, so the operator reads what it does.
export function describePolicy(p, groups = []) {
  const hosts = p.destinations.length > 3 ? `${p.destinations.slice(0, 3).join(", ")} and ${p.destinations.length - 3} more` : joinAnd(p.destinations)
  const where = appliesToText(p, groups)
  const scope = where ? `Applies to ${where}.` : "Not applied to any sandbox yet."
  if (p.action === "block") return `Blocks ${hosts || "…"} and their subdomains, for every program. Beats every allow. ${scope}`
  const a = { ...DEFAULT_ADVANCED, ...p.advanced }
  const requests = a.requests === "custom" ? `only ${a.allow.map((r) => `${r.method} ${r.path}`).join(", ") || "the listed requests"}` : REQUESTS.find((r) => r.id === a.requests)?.label.toLowerCase() + " requests"
  const programs = a.programs.length ? `from ${joinAnd([...new Set(a.programs.map((b) => b.split("/").pop()))])}` : "from any program"
  const except = a.deny.length ? `, except ${a.deny.map((r) => `${r.method} ${r.path}`).join(", ")}` : ""
  const audit = a.enforcement === "audit" ? " Audit only: violations are logged, not blocked." : ""
  return `Allows ${requests}${except} to ${hosts || "…"} on port${a.ports.length === 1 ? "" : "s"} ${joinAnd(a.ports.map(String))}, ${programs}.${audit} ${scope}`
}

export function PolicyDialog({ open, onOpenChange, initial, groups: savedGroups = [], sandboxes = [], assignments = {}, setupMembers = {}, knownPrograms = [], onSaved, onGroupCreated, sourceControl }) {
  const api = useApi()
  const isNew = !initial?.id
  const [form, setForm] = React.useState(() => toForm(initial))
  // Groups made from this form, until the page reloads its list.
  const [created, setCreated] = React.useState([])
  const groups = [...savedGroups, ...created.filter((g) => !savedGroups.some((s) => s.id === g.id))].sort((a, b) => a.name.localeCompare(b.name))
  const [program, setProgram] = React.useState("")
  const [destination, setDestination] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState(null)
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  React.useEffect(() => { if (open) { setForm(toForm(initial)); setError(null); setProgram(""); setDestination(""); setConfirmDelete(false) } }, [open, initial])

  const set = (patch) => setForm((f) => ({ ...f, ...patch }))
  const setTo = (patch) => setForm((f) => ({ ...f, appliesTo: { ...f.appliesTo, ...patch } }))
  // A setup's own policy reaches the sandboxes that use the setup; groups are optional there.
  const forSetup = form.appliesTo.setups?.length > 0
  const validGroup = !form.appliesTo.everyone && !form.appliesTo.sandboxes.length && (forSetup || form.appliesTo.groups.length > 0) && form.appliesTo.groups.every((id) => groups.some((g) => g.id === id))
  const policy = toPolicy(form, isNew)
  // Enter, comma, space or a paste turns what is typed into chips, one per host.
  const addDestinations = (text) => {
    const added = split(text).filter((h, i, all) => !form.destinations.includes(h) && all.indexOf(h) === i)
    if (added.length) set({ destinations: [...form.destinations, ...added] })
    setDestination("")
  }
  const addProgram = (path) => {
    const value = path.trim()
    if (value && !form.programs.includes(value)) set({ programs: [...form.programs, value] })
    setProgram("")
  }
  const counts = Object.fromEntries(groups.map((g) => [g.id, sandboxes.filter((n) => groupFor({ assignments }, n).includes(g.id)).length]))
  const reached = sandboxes.filter((n) => reaches(policy, { name: n, groups: groupFor({ assignments }, n), setups: setupMembers[n] ?? [] }))

  async function submit(event) {
    event.preventDefault()
    if (!validGroup) { setError("Choose at least one group for this network rule."); return }
    setBusy(true); setError(null)
    const pending = split(destination).filter((h) => !policy.destinations.includes(h))
    const saved = { ...policy, destinations: [...policy.destinations, ...pending] }
    try { onSaved(await api.savePolicy({ ...saved, isNew }), saved); onOpenChange(false) } catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  async function remove() {
    setBusy(true); setError(null)
    try { onSaved({ ...(await api.deletePolicy(initial.id)), deleted: true }, initial); onOpenChange(false) } catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-xl">
        <form onSubmit={submit} className="grid gap-5">
          <DialogHeader>
            <DialogTitle>{isNew ? "Add network rule" : `Edit ${initial.name}`}</DialogTitle>
            <DialogDescription className="text-xs">Sandboxes start locked down: nothing leaves them unless a rule allows it. A block beats every allow.</DialogDescription>
          </DialogHeader>

          <fieldset disabled={busy || JSON.stringify(form)!==JSON.stringify(toForm(initial)) || Boolean(destination || program)}>{sourceControl}</fieldset>
          {isNew && (
            <div className="flex flex-wrap gap-1.5">
              <span className="self-center text-[11px] text-muted-foreground">Start from</span>
              {POLICY_PRESETS.map((p) => (
                <button key={p.label} type="button" onClick={() => setForm((f) => ({ ...toForm(newPolicy(p.policy)), appliesTo: f.appliesTo }))}
                  className="rounded border border-border px-2 py-0.5 text-[11px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                  {p.label}
                </button>
              ))}
            </div>
          )}

          <div className="grid gap-1.5">
            <Label htmlFor="policy-name" className="text-xs">Name</Label>
            <Input id="policy-name" value={form.name} onChange={(e) => set({ name: e.target.value })} className="text-xs" placeholder="GitHub read" required autoFocus={isNew} />
          </div>

          <fieldset className="grid gap-2 rounded-lg border border-border bg-muted/20 p-3">
            <legend className="px-1 text-xs font-medium">Groups <span className="text-muted-foreground">· {forSetup ? "Optional" : "Required"}</span></legend>
            {forSetup && <p className="text-[11px] leading-relaxed text-muted-foreground">Applies to sandboxes that use the MCPs &amp; Skills setup{form.setup?.name ? <> “<span className="text-foreground">{form.setup.name}</span>”</> : ""}. Groups you pick here also get it.</p>}
            <GroupPicker multiple required={!forSetup} groups={groups} counts={counts} value={form.appliesTo.groups}
              onChange={(ids) => setTo({ everyone: false, groups: ids, sandboxes: [] })}
              onCreated={(g) => { setCreated((c) => [...c, g]); onGroupCreated?.(g) }} />
            {reached.length > 0 && <p className="text-[11px] text-muted-foreground">{reached.length} {reached.length === 1 ? "sandbox" : "sandboxes"} currently in scope.</p>}
            {(!isNew && !forSetup && (initial.appliesTo.everyone || initial.appliesTo.sandboxes.length || !initial.appliesTo.groups.length)) && <p className="text-[11px] text-amber-700">This rule uses a legacy scope. Choose its groups before saving; saving replaces the previous scope.</p>}
          </fieldset>

          <div className="grid gap-1.5">
            <span className="text-xs font-medium">Action</span>
            <div className="w-48"><Segmented label="Action" options={[{ id: "allow", label: "Allow" }, { id: "block", label: "Block" }]} value={form.action} onChange={(action) => set({ action })} /></div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="policy-destinations" className="text-xs">Destinations</Label>
            <div className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border border-input bg-transparent px-2 py-1.5 focus-within:ring-2 focus-within:ring-ring">
              {form.destinations.map((d) => (
                <span key={d} className="flex items-center gap-1 rounded-md border border-foreground/20 bg-accent py-0.5 pr-0.5 pl-2 font-mono text-[11px]">
                  {d}
                  <button type="button" aria-label={`Remove ${d}`} onClick={() => set({ destinations: form.destinations.filter((x) => x !== d) })}
                    className="rounded p-0.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"><X className="size-3" /></button>
                </span>
              ))}
              <input id="policy-destinations" value={destination} onChange={(e) => (/[\s,]$/.test(e.target.value) ? addDestinations(e.target.value) : setDestination(e.target.value))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); addDestinations(destination) }
                  else if (e.key === "Backspace" && !destination && form.destinations.length) set({ destinations: form.destinations.slice(0, -1) })
                }}
                onBlur={() => addDestinations(destination)}
                className="min-w-32 flex-1 bg-transparent font-mono text-[11px] outline-none placeholder:text-muted-foreground"
                placeholder={form.destinations.length ? "" : form.action === "block" ? "pastebin.com" : "github.com"} aria-label="Destinations" />
            </div>
            <p className="text-[11px] text-muted-foreground">
              {form.action === "block" ? "Press Enter after each host. Blocking a host also blocks its subdomains." : "Press Enter after each host. *.example.com matches one level, **.example.com any depth."}
            </p>
          </div>


          {form.action === "allow" && (
            <details className="group rounded-lg border border-border" open={!isDefault(initial?.advanced) || undefined}>
              <summary className="cursor-pointer px-3 py-2 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">Advanced</summary>
              <div className="grid gap-4 border-t border-border p-3">
                <div className="grid gap-1">
                  <Label htmlFor="policy-ports" className="text-[11px] text-muted-foreground">Ports</Label>
                  <Input id="policy-ports" value={form.ports} onChange={(e) => set({ ports: e.target.value })} className="h-8 w-40 font-mono text-[11px]" placeholder="443, 80" />
                </div>
                <div className="grid gap-1.5">
                  <span className="text-[11px] text-muted-foreground">Requests</span>
                  <Segmented label="Requests" options={REQUESTS} value={form.requests}
                    onChange={(requests) => set({ requests, allow: requests === "custom" && !form.allow.length ? [{ method: "GET", path: "" }] : form.allow })} />
                  {form.requests === "custom" && <RequestList kind="allow" items={form.allow} onChange={(allow) => set({ allow })} />}
                  <RequestList kind="deny" items={form.deny} onChange={(deny) => set({ deny })} />
                </div>
                <div className="grid gap-1.5">
                  <span className="text-[11px] text-muted-foreground">Programs</span>
                  <div className="flex flex-wrap gap-1.5">
                    {form.programs.map((b) => (
                      <span key={b} className="flex items-center gap-1 rounded-md border border-foreground/20 bg-accent py-0.5 pr-0.5 pl-2 font-mono text-[11px]">
                        {b}
                        <button type="button" aria-label={`Remove ${b}`} onClick={() => set({ programs: form.programs.filter((x) => x !== b) })}
                          className="rounded p-0.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"><X className="size-3" /></button>
                      </span>
                    ))}
                    {!form.programs.length && <span className="text-[11px] text-muted-foreground">Any program</span>}
                  </div>
                  <div className="flex gap-1.5">
                    <Input value={program} onChange={(e) => setProgram(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addProgram(program) } }}
                      className="h-8 font-mono text-[11px]" placeholder="/usr/bin/git" title="Globs like /usr/bin/python3* work" aria-label="Program path" />
                    <Button type="button" variant="outline" size="sm" onClick={() => addProgram(program)} disabled={!program.trim()}>Add</Button>
                  </div>
                  {knownPrograms.filter((p) => !form.programs.includes(p)).length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[10px] text-muted-foreground">Seen</span>
                      {knownPrograms.filter((p) => !form.programs.includes(p)).slice(0, 6).map((p) => (
                        <button key={p} type="button" onClick={() => addProgram(p)}
                          className="rounded border border-dashed border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">+ {p}</button>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <div className="w-52"><Segmented label="Enforcement" options={[{ id: "enforce", label: "Enforce" }, { id: "audit", label: "Audit only" }]} value={form.enforcement} onChange={(enforcement) => set({ enforcement })} /></div>
                  {form.enforcement === "audit" && <span className="flex items-center gap-1 text-[11px] text-amber-700"><AlertTriangle className="size-3" />Request rules are logged, not enforced</span>}
                </div>
                <div className="grid gap-1">
                  <Label htmlFor="policy-ips" className="text-[11px] text-muted-foreground" title="Loopback and cloud metadata stay blocked">Private addresses</Label>
                  <Input id="policy-ips" value={form.privateIps} onChange={(e) => set({ privateIps: e.target.value })} className="h-8 font-mono text-[11px]" placeholder="10.0.5.0/24" />
                </div>
              </div>
            </details>
          )}

          <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-[11px] leading-relaxed">{describePolicy(policy, groups)}</p>
          {error && <p role="alert" className="rounded-md border border-red-200 bg-red-50/60 px-3 py-2 text-[11px] text-red-700">{error}</p>}

          <DialogFooter className="sm:justify-between">
            {!isNew ? (
              confirmDelete
                ? <span className="grid gap-1.5">{form.setup && <span className="max-w-64 text-[11px] text-muted-foreground">Sandboxes that use “{form.setup.name}” lose access to these websites. Enabling the setup again asks you to approve them for each sandbox.</span>}<Button type="button" variant="destructive" disabled={busy} onClick={remove}>Delete rule</Button></span>
                : <Button type="button" variant="ghost" className="text-muted-foreground hover:text-destructive" onClick={() => setConfirmDelete(true)}>Delete</Button>
            ) : <span />}
            <span className="flex gap-2">
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button type="submit" disabled={busy || !validGroup || !form.name.trim() || !form.destinations.length && !destination.trim()} className="bg-[var(--action)] text-[var(--action-foreground)] hover:bg-[var(--action)]/90">
                {busy && <Spinner aria-hidden="true" />}{isNew ? "Add rule" : "Save rule"}
              </Button>
            </span>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// The hosts blocked in every sandbox. They beat every rule.
export function BlockedHostsDialog({ open, onOpenChange, org, onSaved }) {
  const api = useApi()
  const [text, setText] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState(null)
  React.useEffect(() => { if (open) { setText((org?.blocked ?? []).join("\n")); setError(null) } }, [open, org])

  async function submit(event) {
    event.preventDefault()
    setBusy(true); setError(null)
    try { onSaved(await api.saveOrg({ ...org, blocked: lines(text) })); onOpenChange(false) } catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Blocked everywhere</DialogTitle>
            <DialogDescription className="text-xs">Blocked in every sandbox, with their subdomains. No rule can open them.</DialogDescription>
          </DialogHeader>
          <Textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} className="font-mono text-[11px]" placeholder={"pastebin.com\n**.ngrok.io"} aria-label="Blocked hosts" />
          {error && <p role="alert" className="rounded-md border border-red-200 bg-red-50/60 px-3 py-2 text-[11px] text-red-700">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy} className="bg-[var(--action)] text-[var(--action-foreground)] hover:bg-[var(--action)]/90">{busy && <Spinner aria-hidden="true" />}Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
