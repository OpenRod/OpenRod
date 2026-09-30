import * as React from "react"
import { Check, Plus, Users } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { api } from "@/lib/api"
import { groupId } from "@/lib/groups"
import { cn } from "@/lib/utils"

function GroupChip({ pressed, onClick, children, count, muted }) {
  return (
    <button type="button" aria-pressed={pressed} onClick={onClick}
      className={cn("flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
        pressed ? "border-foreground/25 bg-accent text-foreground" : "border-border text-muted-foreground hover:text-foreground")}>
      {pressed ? <Check className="size-3" aria-hidden="true" /> : !muted && <Users className="size-3 opacity-60" aria-hidden="true" />}
      {children}
      {count != null && <span className="font-mono text-[10px] tabular-nums text-faint">{count}</span>}
    </button>
  )
}

// Creates a group in place, so nobody has to leave a form to make one.
function NewGroup({ onCreated, existing }) {
  const [open, setOpen] = React.useState(false)
  const [name, setName] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState(null)
  const id = groupId(name)
  const taken = existing.some((g) => g.id === id)

  async function create() {
    if (!id || taken) return
    setBusy(true); setError(null)
    try {
      const { group } = await api.saveGroup({ id, name: name.trim(), description: "", isNew: true })
      setOpen(false); setName("")
      onCreated(group)
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}
        className="flex items-center gap-1 rounded-md border border-dashed border-border px-2.5 py-1 text-[11px] text-muted-foreground outline-none transition-colors hover:border-foreground/30 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        <Plus className="size-3" aria-hidden="true" />New group
      </button>
    )
  }
  return (
    <div className="grid w-full gap-1">
      <div className="flex items-center gap-1.5">
        <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="Frontend" aria-label="New group name" className="h-7 max-w-52 text-xs"
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); create() } if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setOpen(false) } }} />
        <Button type="button" size="xs" onClick={create} disabled={busy || !id || taken} className="bg-[var(--action)] text-[var(--action-foreground)] hover:bg-[var(--action)]/90">
          {busy && <Spinner aria-hidden="true" />}Create
        </Button>
        <Button type="button" size="xs" variant="ghost" onClick={() => { setOpen(false); setName("") }}>Cancel</Button>
      </div>
      {(error || taken) && <p className="text-[11px] text-red-700">{error ?? `A group called "${name.trim()}" already exists.`}</p>}
    </div>
  )
}

// Pick one group (`multiple` false, with "No group") or several.
export function GroupPicker({ groups, counts = {}, value, onChange, multiple = false, onCreated }) {
  const selected = multiple ? value : value ? [value] : []
  const toggle = (id) => {
    if (multiple) onChange(selected.includes(id) ? selected.filter((g) => g !== id) : [...selected, id])
    else onChange(id)
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {!multiple && <GroupChip pressed={!value} onClick={() => onChange(null)} muted>No group</GroupChip>}
      {groups.map((g) => (
        <GroupChip key={g.id} pressed={selected.includes(g.id)} onClick={() => toggle(g.id)} count={counts[g.id]}>{g.name}</GroupChip>
      ))}
      <NewGroup existing={groups} onCreated={(group) => { onCreated?.(group); toggle(group.id) }} />
    </div>
  )
}
