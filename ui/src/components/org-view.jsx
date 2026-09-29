import * as React from "react"
import { Building2, Pencil, Plus, Trash2, Users } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Spinner } from "@/components/ui/spinner"
import { RuleEditor, RULE_PRESETS, RuleLine } from "@/components/rule-editor"
import { api } from "@/lib/api"
import { useLive } from "@/lib/live"

const lines = (text) => text.split("\n").map((s) => s.trim()).filter(Boolean)
const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48)
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "es"}`

function Section({ title, aside, children }) {
  return (
    <section className="space-y-2.5">
      <div className="flex items-center gap-2">
        <h3 className="text-[10px] font-bold tracking-widest text-faint uppercase">{title}</h3>
        {aside && <div className="ml-auto">{aside}</div>}
      </div>
      {children}
    </section>
  )
}

function RuleList({ rules, onChange, knownPrograms, scope }) {
  const [editing, setEditing] = React.useState(null)
  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5">
        {RULE_PRESETS.filter((p) => !rules.some((r) => r.name === p.rule.name)).map((p) => (
          <button key={p.id} type="button" onClick={() => setEditing({ index: -1, spec: structuredClone(p.rule) })}
            className="rounded border border-dashed border-border px-2 py-0.5 text-[11px] text-muted-foreground outline-none hover:border-foreground/30 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
            + {p.label}
          </button>
        ))}
        <Button size="xs" variant="outline" className="ml-auto" onClick={() => setEditing({ index: -1, spec: null })}><Plus />Add rule</Button>
      </div>
      {rules.length === 0 && <p className="rounded-md border border-dashed border-border p-4 text-center text-[11px] text-muted-foreground">No rules yet</p>}
      {rules.map((r, i) => (
        <div key={r.name} className="flex items-start gap-2 rounded-md border border-border bg-card p-2.5">
          <RuleLine rule={r} className="flex-1 text-[11px]" />
          <Button size="icon-xs" variant="ghost" aria-label={`Edit ${r.name}`} onClick={() => setEditing({ index: i, spec: r })}><Pencil /></Button>
          <Button size="icon-xs" variant="ghost" aria-label={`Remove ${r.name}`} onClick={() => onChange(rules.filter((_, j) => j !== i))}><Trash2 /></Button>
        </div>
      ))}
      <RuleEditor open={Boolean(editing)} onOpenChange={(o) => { if (!o) setEditing(null) }} initial={editing?.spec} knownPrograms={knownPrograms}
        title={editing?.index >= 0 ? `Edit ${editing.spec.name}` : `Add rule to ${scope}`} submitLabel={editing?.index >= 0 ? "Update rule" : "Add rule"}
        onSubmit={async (spec) => {
          const next = editing.index >= 0 ? rules.map((r, j) => (j === editing.index ? spec : r)) : [...rules, spec]
          if (new Set(next.map((r) => r.name)).size !== next.length) throw new Error(`Another rule in ${scope} has that name.`)
          onChange(next)
        }} />
    </>
  )
}

function reportSync(result, what) {
  const applied = result.applied?.length ?? 0
  if (result.failed?.length) {
    toast.warning(`Saved ${what}. ${result.failed.length} sandbox${result.failed.length === 1 ? "" : "es"} could not be updated`, { description: result.failed.map((f) => `${f.sandbox}: ${f.error}`).join("\n") })
  } else {
    toast.success(`Saved ${what}`, { description: applied ? `Applied to ${plural(applied, "sandbox")}.` : "No running sandboxes to update yet. New ones get it at creation." })
  }
}

function OrgEditor({ data, onSaved, knownPrograms }) {
  const [draft, setDraft] = React.useState(() => structuredClone(data.org))
  const [blocked, setBlocked] = React.useState(() => data.org.blocked.join("\n"))
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState(null)
  const next = { ...draft, blocked: lines(blocked) }
  const dirty = JSON.stringify(next) !== JSON.stringify(data.org)

  async function save() {
    setBusy(true); setError(null)
    try { reportSync(await api.saveOrg(next), "organization policy"); onSaved() } catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  return (
    <Editor title="Organization" subtitle={plural(data.total, "sandbox")} icon={Building2}
      dirty={dirty} busy={busy} error={error} onSave={save} saveLabel="Save">
      <p className="text-xs text-muted-foreground">Only configured network access is allowed. All other connections stay blocked.</p>
      <Section title="Allowed for everyone">
        <RuleList rules={draft.rules} onChange={(rules) => setDraft({ ...draft, rules })} knownPrograms={knownPrograms} scope="the organization" />
      </Section>
      <Section title="Never allowed">
        <Textarea rows={5} value={blocked} onChange={(e) => setBlocked(e.target.value)} className="font-mono text-[11px]" placeholder={"**.datadoghq.com\n**.segment.io"} aria-label="Blocked hosts"
          title={"One host per line. *. matches one level, **. any depth.\nOverrides every rule."} />
      </Section>
    </Editor>
  )
}

function GroupEditor({ data, group, templates, onSaved, onDeleted, knownPrograms }) {
  const isNew = !data.groups.some((g) => g.id === group.id) || group.isNew
  const [draft, setDraft] = React.useState(() => structuredClone(group))
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState(null)
  const members = data.members[group.id] ?? []
  const { isNew: _, ...clean } = draft
  const dirty = isNew || JSON.stringify(clean) !== JSON.stringify(group)

  async function save() {
    setBusy(true); setError(null)
    try { const result = await api.saveGroup(clean); reportSync(result, `group ${result.group.name}`); onSaved(result.group.id) } catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  async function remove() {
    setBusy(true); setError(null)
    try { await api.deleteGroup(group.id); toast.success(`Deleted group ${group.name}`); onDeleted() } catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  return (
    <Editor title={isNew ? "New group" : draft.name} subtitle={isNew ? null : plural(members.length, "sandbox")} icon={Users}
      dirty={dirty} busy={busy} error={error} onSave={save} saveLabel={isNew ? "Create group" : "Save"}
      extra={!isNew && (
        <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" disabled={busy || members.length > 0} onClick={remove}
          title={members.length ? "Delete its sandboxes first" : undefined}>
          <Trash2 />Delete group
        </Button>
      )}>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="group-name" className="text-xs">Name</Label>
          <Input id="group-name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value, id: isNew ? slug(e.target.value) : draft.id })} className="text-xs" placeholder="Coding agents" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="group-id" className="text-xs">Id</Label>
          <Input id="group-id" value={draft.id} onChange={(e) => setDraft({ ...draft, id: e.target.value.toLowerCase() })} disabled={!isNew} className="font-mono text-xs" />
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="group-desc" className="text-xs">Description</Label>
        <Textarea id="group-desc" rows={2} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} className="text-xs" />
      </div>

      <Section title="Files and process">
        <select value={draft.template} onChange={(e) => setDraft({ ...draft, template: e.target.value })} aria-label="Security preset" title="Security preset for new sandboxes in this group"
          className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring sm:w-80">
          {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </Section>
      <p className="text-xs text-muted-foreground">Only configured network access is allowed. All other connections stay blocked.</p>
      <Section title="Allowed for this group">
        <RuleList rules={draft.rules} onChange={(rules) => setDraft({ ...draft, rules })} knownPrograms={knownPrograms} scope="this group" />
      </Section>
      {!isNew && (
        <Section title="Sandboxes">
          {members.length ? (
            <div className="flex flex-wrap gap-1.5">{members.map((m) => <span key={m} className="rounded border border-border px-1.5 py-0.5 font-mono text-[11px]">{m}</span>)}</div>
          ) : <p className="text-[11px] text-muted-foreground">None yet</p>}
        </Section>
      )}
    </Editor>
  )
}

function Editor({ title, subtitle, icon: Icon, dirty, busy, error, onSave, saveLabel, extra, children }) {
  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-5 sm:px-6">
      <div className="flex items-start gap-2.5">
        <Icon strokeWidth={1.4} className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0">
          <h2 className="truncate text-[15px] font-medium tracking-tight">{title}</h2>
          {subtitle && <p className="text-[11px] text-muted-foreground">{subtitle}</p>}
        </div>
      </div>
      {children}
      {error && <p role="alert" className="rounded-md border border-red-200 bg-red-50/60 px-3 py-2 text-[11px] text-red-700">{error}</p>}
      <div className="sticky bottom-0 flex items-center gap-2 border-t border-border bg-background py-3">
        {extra}
        <span className="ml-auto text-[11px] text-muted-foreground">{dirty ? "Unsaved changes" : ""}</span>
        <Button onClick={onSave} disabled={busy || !dirty} className="bg-[var(--action)] text-[var(--action-foreground)] hover:bg-[var(--action)]/90">
          {busy && <Spinner aria-hidden="true" />}{saveLabel}
        </Button>
      </div>
    </div>
  )
}

function RailRow({ active, onClick, icon: Icon, name, meta, count }) {
  return (
    <button onClick={onClick} aria-current={active ? "true" : undefined}
      className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"}`}>
      <Icon strokeWidth={1.5} className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] text-foreground">{name}</span>
        {meta && <span className="block truncate text-[10px] text-muted-foreground">{meta}</span>}
      </span>
      <span className="shrink-0 font-mono text-[11px] tabular-nums text-faint">{count}</span>
    </button>
  )
}


export function OrgView() {
  const live = useLive()
  const [data, setData] = React.useState(null)
  const [templates, setTemplates] = React.useState([])
  const [selected, setSelected] = React.useState("org")
  const [creating, setCreating] = React.useState(null)

  const load = React.useCallback(async () => {
    try { setData(await api.org()) } catch (e) { setData({ error: e.message }) }
  }, [])
  React.useEffect(() => { load(); api.templates().then(setTemplates).catch(() => setTemplates([])) }, [load])

  const knownPrograms = React.useMemo(() => {
    const set = new Set()
    for (const e of live.events) if (e.binary) set.add(e.binary)
    return [...set].sort()
  }, [live.events])

  if (!data) return <p role="status" className="py-16 text-center text-sm text-muted-foreground">Loading…</p>
  if (data.error) return <p role="alert" className="py-16 text-center text-sm text-muted-foreground">{data.error}</p>

  const group = creating ?? data.groups.find((g) => g.id === selected) ?? null
  const startGroup = () => { setCreating({ isNew: true, id: "", name: "", description: "", template: "locked-down", rules: [], outside: "block" }); setSelected("new") }

  return (
    <div className="flex h-[calc(100svh-3.5rem)] min-h-0 flex-col overflow-hidden">
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <nav aria-label="Policy levels" className="flex max-h-56 shrink-0 flex-col overflow-y-auto border-b border-border p-2.5 md:max-h-none md:w-64 md:border-r md:border-b-0">
          <RailRow active={selected === "org"} onClick={() => { setCreating(null); setSelected("org") }} icon={Building2} name="Organization"
            meta={`${data.org.rules.length} rules · ${data.org.blocked.length} blocked · outside policy blocked`} count={data.total} />
          <div className="flex items-center px-2.5 pt-4 pb-1.5">
            <h2 className="text-[10px] font-bold tracking-widest text-faint uppercase">Groups</h2>
            <Button size="icon-xs" variant="ghost" className="ml-auto" aria-label="New group" onClick={startGroup}><Plus /></Button>
          </div>
          {data.groups.map((g) => (
            <RailRow key={g.id} active={selected === g.id} onClick={() => { setCreating(null); setSelected(g.id) }} icon={Users} name={g.name}
              meta={`${g.rules.length} rules · outside policy blocked`} count={data.members[g.id]?.length ?? 0} />
          ))}
          {creating && <RailRow active icon={Users} name={creating.name || "New group"} meta="not saved" count="" onClick={() => {}} />}
          {data.groups.length === 0 && !creating && (
            <button onClick={startGroup} className="mx-2.5 rounded-md border border-dashed border-border p-3 text-left text-[11px] text-muted-foreground hover:text-foreground">
              Create a group per kind of agent
            </button>
          )}
          {(data.ungrouped.length > 0 || data.orphaned.length > 0) && (
            <p className="mt-4 px-2.5 text-[10px] leading-relaxed text-muted-foreground">
              {data.ungrouped.length > 0 && <>{plural(data.ungrouped.length, "sandbox")} without a group. </>}
              {data.orphaned.length > 0 && <>{plural(data.orphaned.length, "sandbox")} in a deleted group.</>}
            </p>
          )}
        </nav>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {selected === "org" || !group ? (
            <OrgEditor key={JSON.stringify(data.org)} data={data} onSaved={load} knownPrograms={knownPrograms} />
          ) : (
            <GroupEditor key={creating ? "new" : `${group.id}:${JSON.stringify(group)}`} data={data} group={group} templates={templates} knownPrograms={knownPrograms}
              onSaved={async (id) => { setCreating(null); await load(); setSelected(id) }}
              onDeleted={async () => { setSelected("org"); await load() }} />
          )}
        </div>
      </div>
    </div>
  )
}
