import * as React from "react"
import { Check, Plus, Users } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { useApi } from "@/lib/location-context"
import { groupId } from "@/lib/groups"
import { cn } from "@/lib/utils"

function GroupChip({ pressed, onClick, children, count, muted }) {
  return (
    <button type="button" aria-pressed={pressed} onClick={onClick}
      className={cn("flex items-center gap-1.5 rounded-md border px-3 py-2 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
        pressed ? "border-foreground/50 bg-accent font-medium text-foreground" : "border-foreground/20 bg-background text-foreground hover:border-foreground/40 hover:bg-accent/50")}>
      {pressed ? <Check className="size-3" aria-hidden="true" /> : !muted && <Users className="size-3 text-muted-foreground" aria-hidden="true" />}
      {children}
      {count != null && <span className="font-mono text-[10px] tabular-nums text-faint">{count}</span>}
    </button>
  )
}

// Creates a group in place, so nobody has to leave a form to make one.
function NewGroup({ onCreated, existing }) {
  const api = useApi()
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
        className="flex items-center gap-1 rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground outline-none transition-colors hover:border-foreground/30 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
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

// Required single selection uses native radios for keyboard navigation.
export function GroupPicker({ groups, counts = {}, value, onChange, multiple = false, required = false, allowCreate = true, onCreated }) {
  const radioName = React.useId()
  const selected = multiple ? value : value ? [value] : []
  const toggle = (id) => {
    if (multiple) onChange(selected.includes(id) ? selected.filter((g) => g !== id) : [...selected, id])
    else onChange(id)
  }
  return (
    <div role="group" aria-label={multiple ? "Choose groups" : "Choose a group"} className="flex flex-wrap items-center gap-1.5">
      {!multiple && !required && <GroupChip pressed={!value} onClick={() => onChange(null)} muted>No group</GroupChip>}
      {groups.map((g) => (
        required && !multiple ? <label key={g.id} className="relative min-w-0 cursor-pointer">
          <input type="radio" name={radioName} value={g.id} checked={value === g.id} onChange={() => onChange(g.id)} required className="peer sr-only" />
          <span className="flex items-center gap-1.5 rounded-md border border-foreground/20 bg-background px-3 py-2 text-xs text-foreground transition-colors hover:border-foreground/40 hover:bg-accent/50 peer-checked:border-foreground/50 peer-checked:bg-accent peer-checked:font-medium peer-focus-visible:ring-2 peer-focus-visible:ring-ring">
            {value === g.id ? <Check className="size-3 shrink-0" aria-hidden="true" /> : <Users className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />}
            <span className="break-words">{g.name}</span>
            {counts[g.id] != null && <span aria-label={`${counts[g.id]} sandboxes`} className="font-mono text-[10px] text-faint">{counts[g.id]}</span>}
          </span>
        </label> : <GroupChip key={g.id} pressed={selected.includes(g.id)} onClick={() => toggle(g.id)} count={counts[g.id]}>{g.name}</GroupChip>
      ))}
      {allowCreate && <NewGroup existing={groups} onCreated={(group) => { onCreated?.(group); toggle(group.id) }} />}
    </div>
  )
}
