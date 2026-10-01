import { PolicyEditor } from '@/components/policy-editor'
import { BUILTIN_TEMPLATES, composeTemplate } from '../../shared/policy-templates.js'
import * as React from "react"
import { Copy, Pencil, Plus, Search, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { SelectField } from "@/components/ui/select-field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { BlurFade } from "@/components/ui/blur-fade"
import { RuleLine } from "@/components/rule-editor"
import { api } from "@/lib/api"
import { useLive } from "@/lib/live"


// A sandbox's live rules, turned back into editable rule specs.
function rulesFromPolicy(policy) {
  return (policy?.rules ?? []).filter((r) => !r.fromProvider && !/^(org|group)_/.test(r.key)).map((r) => ({
    name: r.key,
    binaries: r.binaries,
    endpoints: r.endpoints.map((e) => ({
      host: e.host, ports: e.ports, protocol: e.protocol,
      ...(e.tlsSkip ? { tlsSkip: true } : {}),
      access: ["read-only", "read-write", "full"].includes(e.access) ? e.access : null,
      allow: e.allow.filter((a) => a.path), deny: e.deny.filter((d) => d.path),
      enforcement: e.enforcement, allowedIps: e.allowedIps,
    })),
  }))
}

function TemplateSummary({ template: saved, templates }) {
  const template = composeTemplate(saved, [], templates)
  const fs = template.filesystem
  return (
    <div className="space-y-2 text-[11px]">
      {saved.kind !== 'access' && <>
      <p><span className="text-muted-foreground">Read & write · </span><span className="font-mono">{[fs.workdir ? "/sandbox" : null, ...fs.readWrite].filter(Boolean).join("  ")}</span></p>
      <p><span className="text-muted-foreground">Read only · </span><span className="font-mono">{fs.readOnly.join("  ") || "-"}</span></p>
      <p><span className="text-muted-foreground">Filesystem enforcement · </span>{template.landlock === "hard_requirement" ? "Required" : "Best effort"}</p>
      <p className="text-muted-foreground">Landlock enforces filesystem access in the Linux kernel. {template.landlock === "hard_requirement" ? "The sandbox fails to start if the required filesystem protection cannot be enforced." : "Applies the filesystem rules it can. If enforcement fails, the sandbox can continue with reduced filesystem protection."}</p>
      </>}
      {saved.kind === 'access' && <p className="text-muted-foreground">Adds network access to the selected base policy. Filesystem protection comes from that base policy.</p>}
      {template.rules.length ? (
        <ul className="space-y-1">{template.rules.map((r) => <li key={r.name}><RuleLine rule={r} /></li>)}</ul>
      ) : <p><span className="text-muted-foreground">Network · </span>Selected agent connections and attached secrets.</p>}
      <p className="text-muted-foreground">Agent connections, attached secrets, and shared rules are added at launch. Organization blocks still apply.</p>
      <p><span className="text-muted-foreground">Opens at start · </span>{template.ingress?.length ? <span className="font-mono">{template.ingress.map((d) => `${d.name || "default"}:${d.port}${d.closeAfterMinutes ? ` (${d.closeAfterMinutes >= 60 ? `${d.closeAfterMinutes / 60}h` : `${d.closeAfterMinutes}m`})` : ""}`).join("  ")}</span> : <span className="font-mono">-</span>}</p>
    </div>
  )
}

// Saved policies define future launches; existing sandboxes retain their rules.
export function PoliciesView() {
  const live = useLive()
  const [templates, setTemplates] = React.useState(null)
  const [editing, setEditing] = React.useState(null)
  const [query, setQuery] = React.useState("")
  const [selected, setSelected] = React.useState(null)
  const [checked, setChecked] = React.useState(new Set())
  const [remove, setRemove] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const [deleteError, setDeleteError] = React.useState(null)
  const load = React.useCallback(() => api.templates().then((items) => {
    setTemplates(items)
    setChecked((current) => new Set([...current].filter(id => items.some(item => item.id === id))))
  }).catch((e) => setTemplates({ error: e.message })), [])
  React.useEffect(() => { load() }, [load])
  const knownPrograms = React.useMemo(() => [...new Set(live.events.map((e) => e.binary).filter(Boolean))].sort(), [live.events])
  const sandboxes = (live.sandboxes ?? []).filter((s) => s.phase !== "deleting")
  const catalog = Array.isArray(templates) ? templates : []
  const edit = (template) => { setSelected(null); setEditing({ ...structuredClone(template), idLocked: true }) }
  const requestDelete = (items) => { setDeleteError(null); setRemove(items) }
  const duplicate = (t) => setEditing({ ...structuredClone(t), ...(t.kind === 'access' ? { rules: [], accessTemplates: [t.id] } : {}), id: `${t.id}-copy`, name: `${t.name} (copy)`, builtin: false, kind: undefined })
  async function fromSandbox(name) {
    try {
      const p = await api.policy(name)
      setEditing({ id: `${name}-policy`, name: `${name} policy`, description: `Captured from ${name}.`, filesystem: p.base.filesystem, landlock: p.base.landlock ?? "best_effort", rules: rulesFromPolicy(p.base) })
    } catch (e) { toast.error(e.message) }
  }
  const shown = catalog.filter((t) =>
    [t.name, t.description, t.id, ...composeTemplate(t, [], catalog).rules.flatMap((r) => r.endpoints.map((e) => e.host))].join(" ").toLowerCase().includes(query.trim().toLowerCase())
  )
  const checkedItems = catalog.filter(item => checked.has(item.id))
  const matchingChecked = shown.filter(item => checked.has(item.id)).length
  const allChecked = shown.length > 0 && matchingChecked === shown.length
  function toggle(id) {
    setChecked(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next })
  }
  function toggleMatching() {
    setChecked(current => { const next = new Set(current); for (const item of shown) { if (allChecked) next.delete(item.id); else next.add(item.id) }; return next })
  }
  async function deletePolicies() {
    if (busy || !remove?.length) return
    setBusy(true); setDeleteError(null)
    try {
      await api.deleteTemplates(remove.map(item => item.id))
      toast.success(`Deleted ${remove.length} ${remove.length === 1 ? 'policy' : 'policies'}`)
      if (remove.some(item => item.id === selected?.id)) setSelected(null)
      if (remove.some(item => item.id === editing?.id)) setEditing(null)
      setRemove(null)
      await load()
    } catch (error) { setDeleteError(error.message) } finally { setBusy(false) }
  }
  return (
    <div className="h-[calc(100svh-3.5rem)] overflow-y-auto">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3 sm:px-8">
        <div className="relative mr-auto min-w-32 flex-1 sm:max-w-60">
          <Search className="pointer-events-none absolute top-2.5 left-2.5 size-3.5 text-faint" />
          <Input aria-label="Search policies" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search…" className="h-8 bg-card pl-8 text-xs" />
        </div>
        {sandboxes.length > 0 && <SelectField value="" onChange={(e) => e.target.value && fromSandbox(e.target.value)} aria-label="Capture a sandbox's policy" className="h-8 rounded-md border border-input bg-card px-2 text-xs">
          <option value="">Capture from sandbox…</option>
          {sandboxes.map((s) => <option key={s.id} value={s.name}>{s.name}</option>)}
        </SelectField>}
        <Button size="sm" disabled={!Array.isArray(templates)} className="bg-[var(--action)] text-[var(--action-foreground)] hover:bg-[var(--action)]/90"
          onClick={() => setEditing({ ...structuredClone(BUILTIN_TEMPLATES[0]), id: "my-policy", name: "", description: "", builtin: false, kind: undefined })}>
          <Plus />New policy
        </Button>
      </div>
      {checkedItems.length > 0 && <div className="flex flex-wrap items-center gap-3 border-b bg-accent/30 px-4 py-2 sm:px-8">
        <span role="status" className="mr-auto text-xs">{checkedItems.length} selected{checkedItems.length > matchingChecked ? ` · ${checkedItems.length - matchingChecked} outside current filters` : ''}</span>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => setChecked(new Set())}>Clear selection</Button>
        <Button variant="destructive" size="sm" disabled={busy} onClick={() => requestDelete(checkedItems)}><Trash2 />Delete selected</Button>
      </div>}
      {templates?.error ? <div role="alert" className="px-4 py-6 text-xs sm:px-8"><p>{templates.error}</p><Button variant="outline" size="sm" className="mt-3" onClick={load}>Try again</Button></div>
        : !templates ? <div role="status" className="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground"><Spinner />Loading…</div>
        : !shown.length ? <div className="py-12 text-center text-xs text-muted-foreground"><p>{query ? 'No matching policies.' : 'No policies yet. Create a policy to use for new sandboxes.'}</p>{query && <Button variant="ghost" size="sm" className="mt-2" onClick={() => setQuery('')}>Clear search</Button>}</div>
        : <BlurFade duration={0.15} offset={0} blur="0px">
          <div className="overflow-x-auto">
            <table aria-label="Policies" className="w-full min-w-[580px] text-left">
              <thead className="border-b text-[11px] text-muted-foreground">
                <tr>
                  <th className="w-12 py-2 pl-4 sm:pl-8"><PolicyCheckbox label="Select all matching policies" checked={allChecked} mixed={matchingChecked > 0 && !allChecked} disabled={busy} onChange={toggleMatching} /></th>
                  <th className="px-4 py-2 font-normal">Name</th><th className="px-4 py-2 font-normal">Network access</th><th className="px-4 py-2 font-normal">Type</th><th className="px-4 py-2"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y">{shown.map((t) => {
                const hosts = [...new Set(composeTemplate(t, [], catalog).rules.flatMap((r) => r.endpoints.map((e) => e.host)))]
                return <tr key={t.id} onClick={() => setSelected(t)} className={`cursor-pointer hover:bg-muted/40 focus-within:bg-muted/40 ${checked.has(t.id) ? 'bg-accent/30' : ''}`}>
                  <td className="py-2 pl-4 sm:pl-8" onClick={(event) => event.stopPropagation()}><PolicyCheckbox label={`Select ${t.name}`} checked={checked.has(t.id)} disabled={busy} onChange={() => toggle(t.id)} /></td>
                  <td className="max-w-72 px-4 py-2"><button aria-haspopup="dialog" aria-label={`Open ${t.name}`} className="block max-w-full truncate rounded text-left text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={(event) => { event.stopPropagation(); setSelected(t) }}>{t.name}</button></td>
                  <td className="px-4 py-2"><span className="block max-w-72 truncate font-mono text-[11px] text-muted-foreground" title={hosts.join(', ') || 'Agent connections and attached secrets'}>{hosts.join(', ') || 'Agent connections & secrets'}</span></td>
                  <td className="px-4 py-2"><span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[11px]"><span className={`size-1.5 rounded-full ${t.builtin ? 'bg-stone-300' : 'bg-emerald-500'}`} />{t.kind === 'access' ? 'Additional access' : t.builtin ? 'Built-in' : 'Custom'}</span></td>
                  <td className="px-4 py-2 text-right sm:pr-8" onClick={(event) => event.stopPropagation()}><div className="flex items-center justify-end gap-1">
                    <Button variant="ghost" size="icon-xs" aria-label={`Edit ${t.name}`} onClick={() => edit(t)}><Pencil /></Button>
                    <Button variant="ghost" size="icon-xs" aria-label={`Delete ${t.name}`} disabled={busy} onClick={() => requestDelete([t])}><Trash2 /></Button>
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
            <div className="rounded-lg border bg-muted/25 p-4"><TemplateSummary template={selected} templates={catalog} /></div>
            <div className="flex flex-wrap items-center gap-2 border-t pt-4">
              <Button variant="ghost" size="sm" onClick={() => { duplicate(selected); setSelected(null) }}><Copy />Duplicate</Button>
              <Button variant="ghost" size="sm" onClick={() => edit(selected)}><Pencil />Edit</Button>
              <Button variant="ghost" size="sm" className="ml-auto text-destructive" onClick={() => requestDelete([selected])}><Trash2 />Delete</Button>
            </div>
          </>}
        </DialogContent>
      </Dialog>
      <PolicyEditor open={Boolean(editing)} initial={editing} onClose={() => setEditing(null)} onSaved={load} onDelete={(item) => requestDelete([item])} knownPrograms={knownPrograms} templates={catalog} />
      <Dialog open={Boolean(remove)} onOpenChange={(open) => { if (!open && !busy) setRemove(null) }}>
        <DialogContent showCloseButton={!busy}>
          <DialogHeader><DialogTitle>Delete {remove?.length === 1 ? 'this policy' : `${remove?.length ?? 0} policies`}?</DialogTitle><DialogDescription>Deleted policies are removed from future launches. Existing sandboxes keep their current rules.</DialogDescription></DialogHeader>
          <ul aria-label="Policies to delete" className="max-h-48 overflow-auto rounded-md border p-3 text-xs">{remove?.map(item => <li key={item.id} className="py-1">{item.name}</li>)}</ul>
          {deleteError && <p role="alert" className="text-xs text-destructive">{deleteError}</p>}
          <div className="flex justify-end gap-2"><Button variant="ghost" disabled={busy} onClick={() => setRemove(null)}>Cancel</Button><Button variant="destructive" disabled={busy} onClick={deletePolicies}>{busy && <Spinner />}{remove?.length === 1 ? 'Delete policy' : 'Delete policies'}</Button></div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function PolicyCheckbox({ label, checked, mixed = false, disabled, onChange }) {
  const ref = React.useRef(null)
  React.useEffect(() => { if (ref.current) ref.current.indeterminate = mixed }, [mixed])
  return <input ref={ref} type="checkbox" aria-label={label} aria-checked={mixed ? 'mixed' : checked} checked={checked} disabled={disabled} onChange={onChange} className="size-3.5 accent-primary" />
}
