import * as React from "react"
import { Copy, FileLock2, Pencil, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
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
          <SheetTitle>{initial?.idLocked ? "Edit security preset" : "New security preset"}</SheetTitle>
        </SheetHeader>
        <div className="space-y-5 px-6 pb-6">
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="tpl-name" className="text-xs">Preset name</Label>
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
                  <select value={String(d.closeAfterMinutes)} onChange={(e) => update({ closeAfterMinutes: e.target.value === "null" ? null : Number(e.target.value) })} aria-label="Close automatically"
                    className="h-7 rounded-md border border-input bg-transparent px-1.5 text-[11px]">
                    {DURATIONS.map((o) => <option key={String(o.minutes)} value={String(o.minutes)}>{o.minutes ? `closes after ${o.label}` : "until closed"}</option>)}
                  </select>
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
          title={rule?.index >= 0 ? `Edit ${rule.spec.name}` : "Add rule to template"} submitLabel={rule?.index >= 0 ? "Update rule" : "Add rule"}
          onSubmit={async (spec) => {
            const rules = rule.index >= 0 ? t.rules.map((r, j) => (j === rule.index ? spec : r)) : [...t.rules, spec]
            if (new Set(rules.map((r) => r.name)).size !== rules.length) throw new Error("Another rule in this template has that name.")
            setT({ ...t, rules })
          }} />
      </SheetContent>
    </Sheet>
  )
}

export function SecurityPresetsView() {
  const live = useLive()
  const [templates, setTemplates] = React.useState(null)
  const [editing, setEditing] = React.useState(null)
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

  if (!templates) return <p role="status" className="py-16 text-center text-sm text-muted-foreground">Loading…</p>
  if (templates.error) return <p role="alert" className="py-16 text-center text-sm text-muted-foreground">{templates.error}</p>

  return (
    <div>
      <div className="flex flex-wrap items-center justify-end gap-2 border-b border-border px-4 py-3 sm:px-6">
        {sandboxes.length > 0 && (
          <select value="" onChange={(e) => e.target.value && fromSandbox(e.target.value)} aria-label="Capture a sandbox's policy"
            className="h-8 rounded-md border border-input bg-transparent px-2 text-[11px] text-muted-foreground">
            <option value="">Capture from sandbox…</option>
            {sandboxes.map((s) => <option key={s.id} value={s.name}>{s.name}</option>)}
          </select>
        )}
        <Button size="sm" className="bg-[var(--action)] text-[var(--action-foreground)] hover:bg-[var(--action)]/90"
          onClick={() => setEditing({ ...structuredClone(templates[0]), id: "my-preset", name: "My preset", description: "", builtin: false })}>
          <Plus />New security preset
        </Button>
      </div>
      <div className="mx-auto grid max-w-5xl gap-3 px-4 py-6 sm:px-6 lg:grid-cols-2">
        {templates.map((t, i) => (
          <BlurFade key={t.id} delay={Math.min(i, 6) * 0.03} duration={0.2} offset={3} blur="1px">
            <div className="flex h-full flex-col rounded-lg border border-border bg-card">
              <div className="flex items-start gap-2 border-b border-border/70 px-4 py-3">
                <FileLock2 strokeWidth={1.4} className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-medium">{t.name}</p>
                  <p className="text-[11px] text-muted-foreground">{t.description || <span className="font-mono">{t.id}</span>}</p>
                </div>
                {t.builtin ? <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">built-in</span> : <span className="font-mono text-[10px] text-muted-foreground">{t.id}.json</span>}
              </div>
              <div className="flex-1 px-4 py-3"><TemplateSummary template={t} /></div>
              <div className="flex gap-1.5 border-t border-border/70 px-4 py-2">
                <Button size="xs" variant="ghost" onClick={() => duplicate(t)}><Copy />Duplicate</Button>
                {!t.builtin && <Button size="xs" variant="ghost" onClick={() => setEditing({ ...t, idLocked: true })}><Pencil />Edit</Button>}
                {!t.builtin && (
                  <Button size="xs" variant="ghost" className="ml-auto text-muted-foreground hover:text-destructive" onClick={async () => {
                    try { await api.deleteTemplate(t.id); toast.success(`Deleted ${t.name}`); load() } catch (e) { toast.error(e.message) }
                  }}><Trash2 />Delete</Button>
                )}
              </div>
            </div>
          </BlurFade>
        ))}
      </div>
      <TemplateEditor open={Boolean(editing)} initial={editing} onClose={() => setEditing(null)} onSaved={load} knownPrograms={knownPrograms} />
    </div>
  )
}
