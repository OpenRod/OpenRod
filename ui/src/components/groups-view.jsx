import * as React from "react"
import { ArrowRight, Check, ChevronRight, Network, Plus, Search, ShieldCheck, ShieldOff, Trash2, Users, X } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { BlurFade } from "@/components/ui/blur-fade"
import { NumberTicker } from "@/components/ui/number-ticker"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { SelectField } from "@/components/ui/select-field"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { POLICY_HANDOFF } from "@/components/egress-view"
import { api } from "@/lib/api"
import { useLive } from "@/lib/live"
import { groupId, groupPolicies, policiesFor } from "@/lib/groups"
import { styleOf } from "@/lib/sandboxes"
import { cn } from "@/lib/utils"

// Groups: sandboxes that share network access. A group is a name; egress
// policies aimed at it reach every sandbox in it, including ones added later.

const NONE = "__none"
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`

function handOff(value) {
  try { sessionStorage.setItem(POLICY_HANDOFF, JSON.stringify(value)) } catch { /* optional */ }
}

function reportSync(result, what) {
  if (result.failed?.length) toast.warning(`${what}. ${plural(result.failed.length, "sandbox", "sandboxes")} could not be updated`, { description: result.failed.map((f) => `${f.sandbox}: ${f.error}`).join("\n") })
  else toast.success(what, { description: result.applied?.length ? `Network access updated in ${plural(result.applied.length, "sandbox", "sandboxes")}.` : undefined })
}

function PolicyPill({ policy, onClick }) {
  const Icon = policy.action === "block" ? ShieldOff : ShieldCheck
  return (
    <button type="button" onClick={onClick} title={`${policy.action === "block" ? "Blocks" : "Allows"} ${policy.destinations.join(", ")}`}
      className={cn("flex max-w-full items-center gap-1 rounded-full border px-2 py-px text-[11px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
        policy.action === "block" ? "border-red-200 bg-red-50 text-red-700 hover:bg-red-100/70" : "border-emerald-600/20 bg-emerald-50 text-emerald-800 hover:bg-emerald-100/70")}>
      <Icon className="size-3 shrink-0" aria-hidden="true" /><span className="truncate">{policy.name}</span>
    </button>
  )
}

function SandboxChips({ names, limit = 4 }) {
  if (!names.length) return <span className="text-[11px] text-faint">No sandboxes yet</span>
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      {names.slice(0, limit).map((n) => <span key={n} className="rounded border border-border bg-background px-1.5 py-px font-mono text-[10.5px] text-muted-foreground">{n}</span>)}
      {names.length > limit && <span className="text-[11px] text-faint">+{names.length - limit}</span>}
    </span>
  )
}

// ---- first run --------------------------------------------------------------

const STEPS = [
  { title: "Create a group", body: "Name it for a kind of work, like Frontend or Data." },
  { title: "Add sandboxes", body: "Here, or by picking the group when you create a sandbox. You can move them any time." },
  { title: "Aim egress policies at it", body: "Every sandbox in the group gets them, including ones you add later." },
]

function FirstRun({ onCreate, onPolicy }) {
  return (
    <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
      <BlurFade>
        <div className="flex items-center gap-2.5">
          <span className="flex size-9 items-center justify-center rounded-xl border border-stone-300 bg-card shadow-[0_3px_8px_#1c191708]"><Users className="size-4.5 text-stone-600" strokeWidth={1.4} /></span>
          <div>
            <h2 className="text-[15px] font-medium tracking-tight">Give sandboxes the same network access, together</h2>
            <p className="text-xs text-muted-foreground">Instead of one policy per sandbox, make a group and aim policies at the group.</p>
          </div>
        </div>
      </BlurFade>
      <ol className="relative mt-8 grid gap-3 sm:grid-cols-3">
        <span aria-hidden="true" className="absolute top-[22px] right-[16%] left-[16%] hidden h-px bg-gradient-to-r from-border via-stone-300 to-border sm:block" />
        {STEPS.map((step, i) => (
          <BlurFade key={step.title} delay={0.08 + i * 0.08} className="relative">
            <li className="flex h-full flex-col rounded-lg border border-border bg-card p-4">
              <span className="relative z-10 flex size-[26px] items-center justify-center rounded-full border border-stone-300 bg-card font-mono text-[11px] text-stone-600">{i + 1}</span>
              <p className="mt-3 text-xs font-medium">{step.title}</p>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{step.body}</p>
            </li>
          </BlurFade>
        ))}
      </ol>
      <BlurFade delay={0.34}>
        <div className="mt-6 flex flex-wrap items-center gap-2">
          <Button onClick={onCreate} className="bg-[var(--action)] text-[var(--action-foreground)] hover:bg-[var(--action)]/90"><Plus />Create your first group</Button>
          <Button variant="ghost" onClick={onPolicy} className="text-muted-foreground">Egress policies<ArrowRight /></Button>
        </div>
      </BlurFade>
    </div>
  )
}

// ---- create -----------------------------------------------------------------

function NewGroupDialog({ open, onOpenChange, groups, sandboxes, assignments, onCreated }) {
  const [name, setName] = React.useState("")
  const [description, setDescription] = React.useState("")
  const [picked, setPicked] = React.useState([])
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState(null)
  React.useEffect(() => { if (open) { setName(""); setDescription(""); setPicked([]); setError(null) } }, [open])
  const id = groupId(name)
  const taken = groups.some((g) => g.id === id)
  const nameOf = (gid) => groups.find((g) => g.id === gid)?.name

  async function submit(event) {
    event.preventDefault()
    setBusy(true); setError(null)
    try {
      const { group } = await api.saveGroup({ id, name: name.trim(), description: description.trim(), isNew: true })
      const result = picked.length ? await api.setGroupMembers(picked, group.id) : null
      onOpenChange(false)
      onCreated(group, result, picked.length)
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>New group</DialogTitle>
            <DialogDescription className="text-xs">Egress policies aimed at this group reach every sandbox in it.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="group-name" className="text-xs">Name</Label>
            <Input id="group-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Frontend" className="text-xs" required autoFocus />
            {taken && <p className="text-[11px] text-red-700">A group with this name already exists.</p>}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="group-description" className="text-xs">Description <span className="font-normal text-muted-foreground">(optional)</span></Label>
            <Textarea id="group-description" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Web apps: npm and GitHub" className="text-xs" />
          </div>
          <div className="grid gap-1.5">
            <span className="text-xs font-medium">Add sandboxes <span className="font-normal text-muted-foreground">(optional)</span></span>
            {sandboxes.length ? (
              <ul className="max-h-48 divide-y divide-border/60 overflow-y-auto rounded-md border border-border">
                {sandboxes.map((s) => {
                  const on = picked.includes(s.name)
                  const current = nameOf(assignments[s.name])
                  return (
                    <li key={s.name}>
                      <label className="flex cursor-pointer items-center gap-2.5 px-3 py-1.5 text-xs hover:bg-muted/50">
                        <input type="checkbox" checked={on} onChange={() => setPicked((p) => (on ? p.filter((n) => n !== s.name) : [...p, s.name]))} className="size-3.5" />
                        <span className={cn("size-1.5 shrink-0 rounded-full", styleOf(s.phase).cell)} aria-hidden="true" />
                        <span className="truncate font-mono">{s.name}</span>
                        {current && <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">{on ? `moves from ${current}` : `in ${current}`}</span>}
                      </label>
                    </li>
                  )
                })}
              </ul>
            ) : <p className="text-[11px] text-muted-foreground">No sandboxes yet. Pick this group when you create one.</p>}
          </div>
          {error && <p role="alert" className="rounded-md border border-red-200 bg-red-50/60 px-3 py-2 text-[11px] text-red-700">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy || !id || taken} className="bg-[var(--action)] text-[var(--action-foreground)] hover:bg-[var(--action)]/90">
              {busy && <Spinner aria-hidden="true" />}Create group{picked.length ? ` with ${plural(picked.length, "sandbox", "sandboxes")}` : ""}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ---- one group --------------------------------------------------------------

function GroupSheet({ group, org, sandboxes, onClose, onChanged, onPolicy }) {
  const [name, setName] = React.useState("")
  const [description, setDescription] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  React.useEffect(() => { if (group) { setName(group.name); setDescription(group.description) } }, [group])
  if (!group) return <Sheet open={false} onOpenChange={() => {}} />
  const members = org.members[group.id] ?? []
  const aimed = groupPolicies(org.policies, group.id)
  const everyone = org.policies.filter((p) => p.appliesTo.everyone)
  const others = sandboxes.filter((s) => !members.includes(s.name))
  const nameOf = (gid) => org.groups.find((g) => g.id === gid)?.name
  const dirty = name.trim() !== group.name || description.trim() !== group.description

  async function save() {
    setBusy(true)
    try { await api.saveGroup({ ...group, name: name.trim() || group.name, description: description.trim() }); toast.success(`Saved ${name.trim() || group.name}`); onChanged() } catch (e) { toast.error(e.message) } finally { setBusy(false) }
  }
  async function move(names, target) {
    setBusy(true)
    try { reportSync(await api.setGroupMembers(names, target), target ? `Added ${names.join(", ")} to ${group.name}` : `Removed ${names.join(", ")} from ${group.name}`); onChanged() } catch (e) { toast.error(e.message) } finally { setBusy(false) }
  }
  async function remove() {
    setBusy(true)
    try { reportSync(await api.deleteGroup(group.id), `Deleted ${group.name}`); onClose(); onChanged() } catch (e) { toast.error(e.message) } finally { setBusy(false); setConfirmDelete(false) }
  }

  return (
    <Sheet open onOpenChange={(open) => { if (!open) onClose() }}>
      <SheetContent className="w-full! overflow-y-auto sm:max-w-[460px]!">
        <SheetHeader className="border-b p-6">
          <SheetTitle className="flex items-center gap-2 text-base"><Users className="size-4 text-muted-foreground" strokeWidth={1.5} />{group.name}</SheetTitle>
          <SheetDescription>{plural(members.length, "sandbox", "sandboxes")} · {plural(aimed.length, "policy", "policies")} aimed at this group</SheetDescription>
        </SheetHeader>
        <div className="space-y-6 px-6 pb-6">
          <section className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="edit-group-name" className="text-xs">Name</Label>
              <Input id="edit-group-name" value={name} onChange={(e) => setName(e.target.value)} className="text-xs" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="edit-group-description" className="text-xs">Description</Label>
              <Textarea id="edit-group-description" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} className="text-xs" />
            </div>
            {dirty && <Button size="sm" className="w-fit bg-[var(--action)] text-[var(--action-foreground)] hover:bg-[var(--action)]/90" disabled={busy} onClick={save}>{busy && <Spinner />}Save</Button>}
          </section>

          <section className="grid gap-2">
            <h3 className="text-[10px] font-bold tracking-widest text-faint uppercase">Sandboxes</h3>
            {members.length ? (
              <ul className="divide-y divide-border/60 rounded-md border border-border">
                {members.map((n) => {
                  const s = sandboxes.find((x) => x.name === n)
                  return (
                    <li key={n} className="flex items-center gap-2.5 px-3 py-1.5">
                      <span className={cn("size-1.5 shrink-0 rounded-full", styleOf(s?.phase).cell)} aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate font-mono text-xs">{n}</span>
                      <Button size="icon-xs" variant="ghost" aria-label={`Remove ${n} from ${group.name}`} disabled={busy} onClick={() => move([n], null)}><X /></Button>
                    </li>
                  )
                })}
              </ul>
            ) : <p className="text-[11px] text-muted-foreground">No sandboxes yet. Add one below, or pick {group.name} when you create a sandbox.</p>}
            {others.length > 0 && (
              <select value="" aria-label={`Add a sandbox to ${group.name}`} disabled={busy} onChange={(e) => e.target.value && move([e.target.value], group.id)}
                className="h-8 w-fit rounded-md border border-dashed border-border bg-transparent px-2 text-[11px] text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <option value="">+ Add sandbox</option>
                {others.map((s) => <option key={s.name} value={s.name}>{s.name}{nameOf(org.assignments[s.name]) ? ` (moves from ${nameOf(org.assignments[s.name])})` : ""}</option>)}
              </select>
            )}
          </section>

          <section className="grid gap-2">
            <h3 className="text-[10px] font-bold tracking-widest text-faint uppercase">Network access</h3>
            {aimed.length ? (
              <div className="flex flex-wrap gap-1.5">{aimed.map((p) => <PolicyPill key={p.id} policy={p} onClick={() => onPolicy({ edit: p.id })} />)}</div>
            ) : <p className="text-[11px] text-muted-foreground">No egress policy is aimed at {group.name} yet, so its sandboxes only get the policies for every sandbox.</p>}
            {everyone.length > 0 && <p className="text-[11px] text-muted-foreground">Also, like every sandbox: {everyone.map((p) => p.name).join(", ")}.</p>}
            <Button variant="outline" size="sm" className="w-fit" onClick={() => onPolicy({ new: { appliesTo: { groups: [group.id] } } })}><Plus />Add policy for {group.name}</Button>
          </section>

          <section className="border-t border-border pt-4">
            <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" disabled={busy} onClick={() => setConfirmDelete(true)}><Trash2 />Delete group</Button>
          </section>
        </div>
        <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete {group.name}?</AlertDialogTitle>
              <AlertDialogDescription>
                {members.length ? `Its ${plural(members.length, "sandbox", "sandboxes")} move to No group and lose the policies aimed at ${group.name}. ` : ""}
                {aimed.length ? `${plural(aimed.length, "policy", "policies")} stop targeting it. ` : ""}The sandboxes themselves are not deleted.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={remove}>Delete group</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </SheetContent>
    </Sheet>
  )
}

// ---- page -------------------------------------------------------------------

function GroupCard({ group, members, policies, onOpen, delay }) {
  return (
    <BlurFade delay={delay} className="h-full">
      <button onClick={onOpen} className="group/card flex h-full w-full flex-col gap-3 rounded-lg border border-border bg-card p-4 text-left outline-none transition-[border-color,box-shadow] hover:border-stone-300 hover:shadow-[0_3px_10px_#1c19170a] focus-visible:ring-2 focus-visible:ring-ring">
        <span className="flex items-start gap-2">
          <Users className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.5} aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-medium">{group.name}</span>
            {group.description && <span className="mt-0.5 line-clamp-2 block text-[11px] text-muted-foreground">{group.description}</span>}
          </span>
          <ChevronRight className="size-3.5 shrink-0 text-faint transition-transform group-hover/card:translate-x-0.5" aria-hidden="true" />
        </span>
        <SandboxChips names={members} />
        <span className="mt-auto flex min-w-0 flex-wrap items-center gap-1 border-t border-border/60 pt-3">
          {policies.length
            ? policies.slice(0, 3).map((p) => <span key={p.id} className={cn("truncate rounded-full border px-2 py-px text-[10.5px]", p.action === "block" ? "border-red-200 bg-red-50 text-red-700" : "border-emerald-600/20 bg-emerald-50 text-emerald-800")}>{p.name}</span>)
            : <span className="text-[11px] text-faint">No policies yet</span>}
          {policies.length > 3 && <span className="text-[11px] text-faint">+{policies.length - 3}</span>}
        </span>
      </button>
    </BlurFade>
  )
}

export function GroupsView({ onNavigate }) {
  const live = useLive()
  const [org, setOrg] = React.useState(null)
  const [creating, setCreating] = React.useState(false)
  const [open, setOpen] = React.useState(null)
  const [query, setQuery] = React.useState("")
  const [selected, setSelected] = React.useState([])
  const [busy, setBusy] = React.useState(false)

  const load = React.useCallback(async () => {
    try { setOrg(await api.org()) } catch (e) { setOrg({ error: e.message }) }
  }, [])
  React.useEffect(() => { load() }, [load])

  const sandboxes = React.useMemo(() => [...(live.sandboxes ?? [])].filter((s) => s.phase !== "deleting").sort((a, b) => a.name.localeCompare(b.name)), [live.sandboxes])
  const policy = (value) => { handOff(value); onNavigate("egress") }

  if (!org) return <p role="status" className="py-24 text-center text-sm text-muted-foreground">Loading…</p>
  if (org.error) return <p role="alert" className="py-24 text-center text-sm text-muted-foreground">{org.error}</p>

  const groups = org.groups
  const assignments = org.assignments ?? {}
  const grouped = sandboxes.filter((s) => assignments[s.name]).length
  const needle = query.trim().toLowerCase()
  const visible = sandboxes.filter((s) => !needle || s.name.includes(needle) || (groups.find((g) => g.id === assignments[s.name])?.name ?? "").toLowerCase().includes(needle))
  const allPicked = visible.length > 0 && visible.every((s) => selected.includes(s.name))

  async function move(names, target) {
    setBusy(true)
    const where = groups.find((g) => g.id === target)?.name
    try {
      reportSync(await api.setGroupMembers(names, target), where ? `Moved ${plural(names.length, "sandbox", "sandboxes")} to ${where}` : `Removed ${plural(names.length, "sandbox", "sandboxes")} from their group`)
      setSelected([])
      await load()
    } catch (e) { toast.error(e.message) } finally { setBusy(false) }
  }

  const dialog = <NewGroupDialog open={creating} onOpenChange={setCreating} groups={groups} sandboxes={sandboxes} assignments={assignments}
    onCreated={async (group, result, added) => {
      if (result) reportSync(result, `Created ${group.name} with ${plural(added, "sandbox", "sandboxes")}`)
      else toast.success(`Created ${group.name}`, { description: "Add sandboxes to it, then aim an egress policy at it." })
      await load()
      setOpen(group.id)
    }} />

  if (!groups.length) return <div className="h-[calc(100svh-3.5rem)] overflow-y-auto"><FirstRun onCreate={() => setCreating(true)} onPolicy={() => onNavigate("egress")} />{dialog}</div>

  return (
    <div className="h-[calc(100svh-3.5rem)] overflow-y-auto">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 pt-4 pb-3 sm:px-6">
        <div className="flex flex-wrap gap-1">
          {[{ label: "Groups", value: groups.length }, { label: "In a group", value: grouped }, { label: "No group", value: sandboxes.length - grouped }].map((item) => (
            <div key={item.label} className="rounded-md px-3 py-1.5">
              <span className="block text-[11px] text-muted-foreground">{item.label}</span>
              <span className="mt-1 block font-mono text-lg leading-none tabular-nums"><NumberTicker value={item.value} /></span>
            </div>
          ))}
        </div>
        <p className="mx-3 hidden max-w-sm text-[11px] leading-relaxed text-muted-foreground lg:block">Egress policies aimed at a group reach every sandbox in it. A sandbox is in one group at a time.</p>
        <Button size="sm" className="ml-auto bg-[var(--action)] text-[var(--action-foreground)] hover:bg-[var(--action)]/90" onClick={() => setCreating(true)}><Plus className="size-3.5" />New group</Button>
      </div>

      <section aria-label="Groups" className="grid gap-3 px-4 py-5 sm:grid-cols-2 sm:px-6 xl:grid-cols-3">
        {groups.map((g, i) => <GroupCard key={g.id} group={g} members={org.members[g.id] ?? []} policies={groupPolicies(org.policies, g.id)} onOpen={() => setOpen(g.id)} delay={i * 0.04} />)}
        <BlurFade delay={groups.length * 0.04} className="h-full">
          <button onClick={() => setCreating(true)} className="flex h-full min-h-32 w-full flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-border text-[11px] text-muted-foreground outline-none transition-colors hover:border-foreground/30 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
            <Plus className="size-4" strokeWidth={1.5} aria-hidden="true" />New group
          </button>
        </BlurFade>
      </section>

      <section aria-label="Sandboxes and their groups" className="border-t border-border">
        <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 sm:px-6">
          <h2 className="text-xs font-medium">Sandboxes</h2>
          <span className="text-[11px] text-muted-foreground">Pick a group for each one. Its network access updates right away.</span>
          <div className="relative ml-auto w-full sm:w-56">
            <Search aria-hidden="true" className="absolute top-2.5 left-3 size-3.5 text-muted-foreground" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search sandbox or group…" aria-label="Search sandboxes" className="h-9 pl-9 text-xs" />
          </div>
        </div>
        {selected.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-y border-border bg-accent/50 px-4 py-2 text-xs sm:px-6">
            <Check className="size-3.5" aria-hidden="true" />{plural(selected.length, "sandbox", "sandboxes")} selected
            <SelectField value="" onChange={(e) => e.target.value && move(selected, e.target.value === NONE ? null : e.target.value)} disabled={busy} aria-label="Move selected sandboxes to" className="h-7 w-48 text-xs">
              <option value="" disabled>Move to…</option>
              {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              <option value={NONE}>No group</option>
            </SelectField>
            <Button variant="ghost" size="sm" onClick={() => setSelected([])}>Clear</Button>
            {busy && <Spinner aria-hidden="true" />}
          </div>
        )}
        {sandboxes.length ? (
          <div className="overflow-x-auto">
            <div className="min-w-[640px]">
              <div className="grid h-9 grid-cols-[28px_minmax(0,1.4fr)_minmax(180px,1fr)_minmax(0,1.2fr)] items-center gap-4 border-y border-border bg-muted px-4 text-xs font-medium text-muted-foreground sm:px-6">
                <input type="checkbox" aria-label="Select every sandbox shown" checked={allPicked} onChange={() => setSelected(allPicked ? [] : visible.map((s) => s.name))} className="size-3.5" />
                <span>Sandbox</span><span>Group</span><span className="flex items-center gap-1"><Network className="size-3" aria-hidden="true" />Egress policies</span>
              </div>
              <ul className="divide-y divide-border/60 bg-card">
                {visible.map((s) => {
                  const current = assignments[s.name] ?? null
                  const reach = policiesFor(org.policies, { name: s.name, group: current })
                  const on = selected.includes(s.name)
                  return (
                    <li key={s.name} className={cn("grid min-h-11 grid-cols-[28px_minmax(0,1.4fr)_minmax(180px,1fr)_minmax(0,1.2fr)] items-center gap-4 px-4 py-1.5 sm:px-6", on && "bg-accent/40")}>
                      <input type="checkbox" aria-label={`Select ${s.name}`} checked={on} onChange={() => setSelected((p) => (on ? p.filter((n) => n !== s.name) : [...p, s.name]))} className="size-3.5" />
                      <span className="flex min-w-0 items-center gap-2.5">
                        <span className={cn("size-2 shrink-0 rounded-[3px]", styleOf(s.phase).cell)} aria-hidden="true" />
                        <span className="truncate font-mono text-xs">{s.name}</span>
                      </span>
                      <SelectField value={current ?? NONE} disabled={busy} aria-label={`Group for ${s.name}`} className="h-8 w-full text-xs"
                        onChange={(e) => { const next = e.target.value === NONE ? null : e.target.value; if (next !== current) move([s.name], next) }}>
                        <option value={NONE}>No group</option>
                        {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                      </SelectField>
                      <span className="truncate text-[11px] text-muted-foreground" title={reach.map((p) => p.name).join("\n")}>
                        {reach.length ? reach.map((p) => p.name).join(", ") : <span className="text-faint" title="Its security preset and agent rules still apply">No egress policies</span>}
                      </span>
                    </li>
                  )
                })}
                {!visible.length && <li className="px-6 py-8 text-center text-xs text-muted-foreground">No sandbox matches “{query}”.</li>}
              </ul>
            </div>
          </div>
        ) : <p className="px-6 py-10 text-center text-xs text-muted-foreground">No sandboxes yet. When you create one, pick a group for it in the New sandbox dialog.</p>}
      </section>

      {dialog}
      <GroupSheet group={groups.find((g) => g.id === open) ?? null} org={org} sandboxes={sandboxes} onClose={() => setOpen(null)} onChanged={load} onPolicy={policy} />
    </div>
  )
}
