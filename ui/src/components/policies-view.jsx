import * as React from "react"
import { ArrowRight, Copy, Pencil, Plus, Search, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { SelectField } from "@/components/ui/select-field"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Spinner } from "@/components/ui/spinner"
import { BlurFade } from "@/components/ui/blur-fade"
import { RuleEditor, RuleLine } from "@/components/rule-editor"
import { DURATIONS } from "@/components/ingress-view"
import { api } from "@/lib/api"
import { useLive } from "@/lib/live"

const lines = (text) => text.split("\n").map((s) => s.trim()).filter(Boolean)

// A sandbox's live rules, turned back into editable rule specs.
function rulesFromPolicy(policy) {
  return (policy?.rules ?? []).filter((r) => !r.fromProvider && !/^(org|group)_/.test(r.key)).map((r) => ({
    name: r.key,
    binaries: r.binaries,
    endpoints: r.endpoints.map((e) => ({
      host: e.host, ports: e.ports, protocol: e.protocol,
      access: ["read-only", "read-write", "full"].includes(e.access) ? e.access : null,
      allow: e.allow.filter((a) => a.path), deny: e.deny.filter((d) => d.path),
      enforcement: e.enforcement, allowedIps: e.allowedIps,
    })),
  }))
}

function TemplateSummary({ template }) {
  const fs = template.filesystem
  return (
    <div className="space-y-2 text-[11px]">
      <p><span className="text-muted-foreground">Read & write · </span><span className="font-mono">{[fs.workdir ? "/sandbox" : null, ...fs.readWrite].filter(Boolean).join("  ")}</span></p>
      <p><span className="text-muted-foreground">Read only · </span><span className="font-mono">{fs.readOnly.join("  ") || "-"}</span></p>
      <p><span className="text-muted-foreground">Landlock · </span><span className="font-mono">{template.landlock === "hard_requirement" ? "required" : "best effort"}</span></p>
      {template.rules.length ? (
        <ul className="space-y-1">{template.rules.map((r) => <li key={r.name}><RuleLine rule={r} /></li>)}</ul>
      ) : <p><span className="text-muted-foreground">Network · </span><span className="font-mono">-</span></p>}
      <p><span className="text-muted-foreground">Opens at start · </span>{template.ingress?.length ? <span className="font-mono">{template.ingress.map((d) => `${d.name || "default"}:${d.port}${d.closeAfterMinutes ? ` (${d.closeAfterMinutes >= 60 ? `${d.closeAfterMinutes / 60}h` : `${d.closeAfterMinutes}m`})` : ""}`).join("  ")}</span> : <span className="font-mono">-</span>}</p>
    </div>
  )
}

function TemplateEditor({ open, initial, onClose, onSaved, knownPrograms }) {
  const [t, setT] = React.useState(null)
  const [ro, setRo] = React.useState("")
  const [rw, setRw] = React.useState("")
  const [rule, setRule] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState(null)
  React.useEffect(() => {
    if (!open || !initial) return
    setT(structuredClone(initial)); setRo(initial.filesystem.readOnly.join("\n")); setRw(initial.filesystem.readWrite.join("\n")); setError(null)
  }, [open, initial])
  if (!t) return null

  async function save() {
    setBusy(true); setError(null)
    try {
      const saved = await api.saveTemplate({ ...t, filesystem: { ...t.filesystem, readOnly: lines(ro), readWrite: lines(rw) } })
      toast.success(`Saved ${saved.name}`)
      onSaved(); onClose()
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <SheetContent className="w-full! overflow-y-auto sm:max-w-[560px]!" aria-describedby={undefined}>
        <SheetHeader className="border-b p-6">
          <SheetTitle>{initial?.idLocked ? "Edit policy" : "New policy"}</SheetTitle>
        </SheetHeader>
        <div className="space-y-5 px-6 pb-6">
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="tpl-name" className="text-xs">Policy name</Label>
              <Input id="tpl-name" value={t.name} onChange={(e) => setT({ ...t, name: e.target.value, id: t.idLocked ? t.id : e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) })} className="text-xs" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="tpl-id" className="text-xs">File</Label>
              <Input id="tpl-id" value={t.id} onChange={(e) => setT({ ...t, id: e.target.value.toLowerCase() })} disabled={t.idLocked} className="font-mono text-xs" />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="tpl-desc" className="text-xs">Description</Label>
            <Textarea id="tpl-desc" rows={2} value={t.description} onChange={(e) => setT({ ...t, description: e.target.value })} className="text-xs" />
          </div>

          <section className="space-y-3">
            <h3 className="text-[10px] font-bold tracking-widest text-faint uppercase">Files</h3>
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={t.filesystem.workdir} onChange={(e) => setT({ ...t, filesystem: { ...t.filesystem, workdir: e.target.checked } })} className="size-4 accent-primary" />
              Work folder <span className="font-mono">/sandbox</span> is writable
            </label>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="tpl-rw" className="text-xs">Read & write</Label>
                <Textarea id="tpl-rw" rows={5} value={rw} onChange={(e) => setRw(e.target.value)} className="font-mono text-[11px]" placeholder="/tmp" />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="tpl-ro" className="text-xs">Read only</Label>
                <Textarea id="tpl-ro" rows={5} value={ro} onChange={(e) => setRo(e.target.value)} className="font-mono text-[11px]" placeholder="/usr" />
              </div>
            </div>
            <div className="grid gap-1.5">
              <span className="text-xs font-medium" title="Required: refuse to start if any path can't be enforced. Best effort: skip and log.">Landlock</span>
              <div className="flex w-fit items-center gap-1 rounded-md border border-border p-0.5">
                {[["best_effort", "Best effort"], ["hard_requirement", "Required"]].map(([id, label]) => (
                  <button key={id} type="button" onClick={() => setT({ ...t, landlock: id })} aria-pressed={t.landlock === id}
                    className={`rounded px-2.5 py-1 text-[11px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${t.landlock === id ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}`}>{label}</button>
                ))}
              </div>
            </div>
          </section>

          <section className="space-y-2">
            <div className="flex items-center">
              <h3 className="text-[10px] font-bold tracking-widest text-faint uppercase">Network rules</h3>
              <Button size="xs" variant="outline" className="ml-auto" onClick={() => setRule({ index: -1, spec: null })}><Plus />Add rule</Button>
            </div>
            {t.rules.length === 0 && <p className="text-[11px] text-muted-foreground">None.</p>}
            {t.rules.map((r, i) => (
              <div key={r.name} className="flex items-start gap-2 rounded-md border border-border p-2.5">
                <RuleLine rule={r} className="flex-1 text-[11px]" />
                <Button size="icon-xs" variant="ghost" aria-label={`Edit ${r.name}`} onClick={() => setRule({ index: i, spec: r })}><Pencil /></Button>
                <Button size="icon-xs" variant="ghost" aria-label={`Remove ${r.name}`} onClick={() => setT({ ...t, rules: t.rules.filter((_, j) => j !== i) })}><Trash2 /></Button>
              </div>
            ))}
          </section>

          <section className="space-y-2">
            <div className="flex items-center">
              <h3 className="text-[10px] font-bold tracking-widest text-faint uppercase">Open at start</h3>
              <Button size="xs" variant="outline" className="ml-auto" onClick={() => setT({ ...t, ingress: [...(t.ingress ?? []), { name: (t.ingress ?? []).length ? `web-${(t.ingress ?? []).length + 1}` : "web", port: 8080, closeAfterMinutes: 480 }] })}><Plus />Add service</Button>
            </div>
            {!(t.ingress ?? []).length && <p className="text-[11px] text-muted-foreground">None.</p>}
            {(t.ingress ?? []).map((d, i) => {
              const update = (patch) => setT({ ...t, ingress: t.ingress.map((x, j) => (j === i ? { ...x, ...patch } : x)) })
              return (
                <div key={i} className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2.5">
                  <Input value={d.name} onChange={(e) => update({ name: e.target.value.toLowerCase() })} className="h-7 w-28 font-mono text-[11px]" aria-label="Service name" placeholder="name" />
                  <span className="text-[11px] text-muted-foreground">port</span>
                  <Input value={d.port} onChange={(e) => update({ port: Number(e.target.value.replace(/\D/g, "")) || "" })} className="h-7 w-20 font-mono text-[11px]" aria-label="Port inside" inputMode="numeric" />
                  <SelectField value={String(d.closeAfterMinutes)} onChange={(e) => update({ closeAfterMinutes: e.target.value === "null" ? null : Number(e.target.value) })} aria-label="Close automatically"
                    className="h-7 rounded-md border border-input bg-transparent px-1.5 text-[11px]">
                    {DURATIONS.map((o) => <option key={String(o.minutes)} value={String(o.minutes)}>{o.minutes ? `closes after ${o.label}` : "until closed"}</option>)}
                  </SelectField>
                  <Button size="icon-xs" variant="ghost" className="ml-auto" aria-label="Remove service" onClick={() => setT({ ...t, ingress: t.ingress.filter((_, j) => j !== i) })}><Trash2 /></Button>
                </div>
              )
            })}
          </section>

          {error && <p role="alert" className="rounded-md border border-red-200 bg-red-50/60 px-3 py-2 text-[11px] text-red-700">{error}</p>}
          <div className="flex justify-end gap-2 border-t border-border pt-4">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button onClick={save} disabled={busy || !t.id} className="bg-[var(--action)] text-[var(--action-foreground)] hover:bg-[var(--action)]/90">{busy && <Spinner aria-hidden="true" />}Save</Button>
          </div>
        </div>
        <RuleEditor open={Boolean(rule)} onOpenChange={(o) => { if (!o) setRule(null) }} initial={rule?.spec} knownPrograms={knownPrograms}
          title={rule?.index >= 0 ? `Edit ${rule.spec.name}` : "Add rule to policy"} submitLabel={rule?.index >= 0 ? "Update rule" : "Add rule"}
          onSubmit={async (spec) => {
            const rules = rule.index >= 0 ? t.rules.map((r, j) => (j === rule.index ? spec : r)) : [...t.rules, spec]
            if (new Set(rules.map((r) => r.name)).size !== rules.length) throw new Error("Another rule in this policy has that name.")
            setT({ ...t, rules })
          }} />
      </SheetContent>
    </Sheet>
  )
}

// Saved policies: the files and starting network rules a sandbox is created
// with. New sandbox picks one; later changes happen on the Network page.
export function PoliciesView() {
  const live = useLive()
  const [templates, setTemplates] = React.useState(null)
  const [editing, setEditing] = React.useState(null)
  const [query, setQuery] = React.useState("")
  const [selected, setSelected] = React.useState(null)
  const [remove, setRemove] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const load = React.useCallback(() => api.templates().then(setTemplates).catch((e) => setTemplates({ error: e.message })), [])
  React.useEffect(() => { load() }, [load])
  const knownPrograms = React.useMemo(() => [...new Set(live.events.map((e) => e.binary).filter(Boolean))].sort(), [live.events])
  const sandboxes = (live.sandboxes ?? []).filter((s) => s.phase !== "deleting")

  const duplicate = (t) => setEditing({ ...structuredClone(t), id: `${t.id}-copy`, name: `${t.name} (copy)`, builtin: false })
  async function fromSandbox(name) {
    try {
      const p = await api.policy(name)
      setEditing({ id: `${name}-policy`, name: `${name} policy`, description: `Captured from ${name}.`, filesystem: p.base.filesystem, landlock: p.base.landlock ?? "best_effort", rules: rulesFromPolicy(p.base) })
    } catch (e) { toast.error(e.message) }
  }

  const shown = Array.isArray(templates) ? templates.filter((t) =>
    [t.name, t.description, t.id, ...t.rules.flatMap((r) => r.endpoints.map((e) => e.host))].join(" ").toLowerCase().includes(query.trim().toLowerCase())
  ) : []

  return (
    <div className="h-[calc(100svh-3.5rem)] overflow-y-auto">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3 sm:px-8">
        <div className="relative mr-auto min-w-32 flex-1 sm:max-w-60">
          <Search className="pointer-events-none absolute top-2.5 left-2.5 size-3.5 text-faint" />
          <Input aria-label="Search policies" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search…" className="h-8 bg-card pl-8 text-xs" />
        </div>
        {sandboxes.length > 0 && (
          <SelectField value="" onChange={(e) => e.target.value && fromSandbox(e.target.value)} aria-label="Capture a sandbox's policy"
            className="h-8 rounded-md border border-input bg-card px-2 text-xs">
            <option value="">Capture from sandbox…</option>
            {sandboxes.map((s) => <option key={s.id} value={s.name}>{s.name}</option>)}
          </SelectField>
        )}
        <Button size="sm" disabled={!Array.isArray(templates)} className="bg-[var(--action)] text-[var(--action-foreground)] hover:bg-[var(--action)]/90"
          onClick={() => setEditing({ ...structuredClone(templates[0]), id: "my-policy", name: "My policy", description: "", builtin: false })}>
          <Plus />New policy
        </Button>
      </div>
      {templates?.error ? <div role="alert" className="px-4 py-6 text-xs sm:px-8"><p>{templates.error}</p><Button variant="outline" size="sm" className="mt-3" onClick={load}>Try again</Button></div>
        : !templates ? <div role="status" className="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground"><Spinner />Loading…</div>
        : !shown.length ? <div className="py-12 text-center text-xs text-muted-foreground"><p>No matching policies.</p><Button variant="ghost" size="sm" className="mt-2" onClick={() => setQuery('')}>Clear search</Button></div>
        : <BlurFade duration={0.15} offset={0} blur="0px">
          <div className="overflow-x-auto">
            <table aria-label="Policies" className="w-full min-w-[580px] text-left">
              <thead className="border-b text-[11px] text-muted-foreground">
                <tr><th className="px-4 py-2 font-normal sm:pl-8">Name</th><th className="px-4 py-2 font-normal">Network access</th><th className="px-4 py-2 font-normal">Type</th><th className="px-4 py-2"><span className="sr-only">Actions</span></th></tr>
              </thead>
              <tbody className="divide-y">{shown.map((t) => {
                const hosts = [...new Set(t.rules.flatMap((r) => r.endpoints.map((e) => e.host)))]
                return <tr key={t.id} className="hover:bg-muted/40">
                  <td className="max-w-72 px-4 py-2 sm:pl-8"><button className="block max-w-full truncate rounded text-left text-xs font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setSelected(t)}>{t.name}</button></td>
                  <td className="px-4 py-2"><span className="block max-w-72 truncate font-mono text-[11px] text-muted-foreground" title={hosts.join(', ') || 'No starting network rules'}>{hosts.join(', ') || 'Attached secrets only'}</span></td>
                  <td className="px-4 py-2"><span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[11px]"><span className={`size-1.5 rounded-full ${t.builtin ? 'bg-stone-300' : 'bg-emerald-500'}`} />{t.builtin ? 'Built-in' : 'Custom'}</span></td>
                  <td className="px-4 py-2 text-right sm:pr-8"><div className="flex items-center justify-end gap-1">
                    {!t.builtin && <Button variant="ghost" size="xs" aria-label={`Edit ${t.name}`} onClick={() => setEditing({ ...t, idLocked: true })}><Pencil />Edit</Button>}
                    <Button variant="ghost" size="xs" onClick={() => setSelected(t)}>View policy<ArrowRight /></Button>
                  </div></td>
                </tr>
              })}</tbody>
            </table>
          </div>
        </BlurFade>}
      <Dialog open={Boolean(selected)} onOpenChange={(open) => { if (!open) setSelected(null) }}>
        <DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-2xl">
          {selected && <>
            <DialogHeader><DialogTitle>{selected.name}</DialogTitle><DialogDescription>{selected.description || 'Reusable filesystem and network rules.'}</DialogDescription></DialogHeader>
            <div className="rounded-lg border bg-muted/25 p-4"><TemplateSummary template={selected} /></div>
            <div className="flex flex-wrap items-center gap-2 border-t pt-4">
              <Button variant="ghost" size="sm" onClick={() => { duplicate(selected); setSelected(null) }}><Copy />Duplicate</Button>
              {!selected.builtin && <>
                <Button variant="ghost" size="sm" onClick={() => { setEditing({ ...selected, idLocked: true }); setSelected(null) }}><Pencil />Edit policy</Button>
                <Button variant="ghost" size="icon-sm" aria-label="Remove policy" onClick={() => setRemove(selected)}><Trash2 /></Button>
              </>}
            </div>
          </>}
        </DialogContent>
      </Dialog>
      <Dialog open={Boolean(remove)} onOpenChange={(open) => { if (!open) setRemove(null) }}>
        <DialogContent><DialogHeader><DialogTitle>Remove this policy?</DialogTitle><DialogDescription>The saved policy will be removed. Existing sandboxes keep what they were created with.</DialogDescription></DialogHeader>
          <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setRemove(null)}>Keep policy</Button><Button variant="destructive" disabled={busy} onClick={async () => {
            setBusy(true)
            try { await api.deleteTemplate(remove.id); toast.success(`Deleted ${remove.name}`); setRemove(null); setSelected(null); await load() } catch (e) { toast.error(e.message) } finally { setBusy(false) }
          }}>{busy && <Spinner />}Remove policy</Button></div>
        </DialogContent>
      </Dialog>
      <TemplateEditor open={Boolean(editing)} initial={editing} onClose={() => setEditing(null)} onSaved={load} knownPrograms={knownPrograms} />
    </div>
  )
}
