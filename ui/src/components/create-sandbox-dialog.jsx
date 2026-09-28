import * as React from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Spinner } from "@/components/ui/spinner"
import { api } from "@/lib/api"
import { useLive } from "@/lib/live"

const PRESETS = [
  { id: "claude", label: "Claude Code", command: "claude" },
  { id: "shell", label: "Shell", command: "" },
  { id: "custom", label: "Custom", command: null },
]

function nextName(taken) {
  for (let i = 1; i < 1000; i++) {
    const name = `claude-${i}`
    if (!taken.has(name)) return name
  }
  return ""
}

const OUTSIDE_TEXT = { block: "rest blocked", auto: "safe auto-approved", ask: "rest needs review" }

// What the sandbox will be allowed before it starts, in one line.
function groupSummary(org, id, templates) {
  if (!org) return "Organization policy"
  const g = org.groups.find((x) => x.id === id)
  const orgRules = org.org.rules.length
  if (!g) return `${orgRules} org rules · ${OUTSIDE_TEXT[org.org.outside]}`
  const outside = g.outside === "inherit" ? org.org.outside : g.outside
  const tpl = templates.find((t) => t.id === g.template)?.name ?? g.template
  return `${tpl} · ${orgRules + g.rules.length} rules · ${OUTSIDE_TEXT[outside]}`
}

export function CreateSandboxDialog({ open, onOpenChange, onCreated }) {
  const { sandboxes, overview } = useLive()
  const providers = overview?.providers ?? []
  const [name, setName] = React.useState("")
  const [image, setImage] = React.useState("")
  const [chosen, setChosen] = React.useState([])
  const [preset, setPreset] = React.useState("claude")
  const [custom, setCustom] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState(null)
  const [templates, setTemplates] = React.useState([])
  const [template, setTemplate] = React.useState("locked-down")
  const [org, setOrg] = React.useState(null)
  const [group, setGroup] = React.useState(null)

  // Start from what this gateway already runs: the most-used image and every
  // provider, so the common case is one click.
  React.useEffect(() => {
    if (!open) return
    const list = sandboxes ?? []
    const counts = {}
    for (const s of list) if (s.image) counts[s.image] = (counts[s.image] ?? 0) + 1
    setName(nextName(new Set(list.map((s) => s.name))))
    setImage(Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "")
    setChosen(providers.map((p) => p.name))
    setPreset("claude"); setCustom(""); setError(null); setTemplate("locked-down")
    api.templates().then(setTemplates).catch(() => setTemplates([]))
    // No preselected group: membership is permanent, so it is always a deliberate choice.
    api.org().then((o) => { setOrg(o); setGroup(o.groups.length ? null : "") }).catch(() => { setOrg(null); setGroup("") })
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const command = preset === "custom" ? custom : PRESETS.find((p) => p.id === preset).command

  async function submit(event) {
    event.preventDefault()
    setBusy(true); setError(null)
    try {
      // A group brings its own template; without one the template is picked here.
      const created = await api.create({ name: name.trim(), image: image.trim(), providers: chosen, command: command.trim().split(/\s+/).filter(Boolean), ...(group ? { group } : { template }) })
      toast.success(`Creating ${created.name}`, { description: command ? `Attach with: openshell sandbox connect ${created.name}` : undefined })
      for (const door of created.opened ?? []) toast(`Opened ${door.name || "default"} on port ${door.port}`, { description: door.url ?? undefined })
      onOpenChange(false)
      onCreated?.(created.name)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>New sandbox</DialogTitle>
          </DialogHeader>

          <div className="grid gap-1.5">
            <Label htmlFor="sandbox-name" className="text-xs">Name</Label>
            <Input id="sandbox-name" value={name} onChange={(e) => setName(e.target.value.toLowerCase())} className="font-mono text-xs" required
              pattern="[a-z0-9]([a-z0-9\-]{0,61}[a-z0-9])?" title="Lowercase letters, digits and dashes" autoFocus />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="sandbox-image" className="text-xs">Image</Label>
            <Input id="sandbox-image" value={image} onChange={(e) => setImage(e.target.value)} className="font-mono text-xs" placeholder="Default" title="Local images need Docker running" />
          </div>

          <div className="grid gap-1.5">
            <span className="text-xs font-medium">Runs</span>
            <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
              {PRESETS.map((p) => (
                <button key={p.id} type="button" onClick={() => setPreset(p.id)} aria-pressed={preset === p.id}
                  className={`flex-1 rounded px-2.5 py-1 text-[11px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${preset === p.id ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
                  {p.label}
                </button>
              ))}
            </div>
            {preset === "custom" && (
              <Input value={custom} onChange={(e) => setCustom(e.target.value)} className="font-mono text-xs" placeholder="Command" aria-label="Command" />
            )}
          </div>

          <div className="grid gap-1.5">
            <span className="text-xs font-medium">Providers</span>
            {providers.length ? (
              <div className="flex flex-wrap gap-1.5">
                {providers.map((p) => {
                  const on = chosen.includes(p.name)
                  return (
                    <button key={p.name} type="button" aria-pressed={on}
                      onClick={() => setChosen((c) => (on ? c.filter((n) => n !== p.name) : [...c, p.name]))}
                      className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${on ? "border-foreground/25 bg-accent" : "border-border text-muted-foreground hover:text-foreground"}`}>
                      <span className={`size-1.5 rounded-full ${on ? "bg-emerald-500" : "bg-stone-300"}`} aria-hidden="true" />
                      <span className="font-mono">{p.name}</span>
                      <span className="text-muted-foreground">{p.type}</span>
                    </button>
                  )
                })}
              </div>
            ) : <p className="text-[11px] text-muted-foreground">No providers</p>}
            {preset === "claude" && !chosen.some((n) => providers.find((p) => p.name === n)?.type === "claude-code") && (
              <p className="text-[11px] text-amber-700">Claude Code needs a claude-code provider</p>
            )}
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="sandbox-group" className="text-xs" title="Can't be changed later">Group</Label>
            <select id="sandbox-group" value={group ?? "choose"} onChange={(e) => setGroup(e.target.value)} required
              className="h-8 rounded-md border border-input bg-transparent px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring">
              {group === null && <option value="choose" disabled>Choose…</option>}
              {(org?.groups ?? []).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              <option value="">No group</option>
            </select>
            {group !== null && <p className="text-[11px] text-muted-foreground">{groupSummary(org, group, templates)}</p>}
          </div>

          {group === "" && <div className="grid gap-1.5">
            <Label htmlFor="sandbox-template" className="text-xs">Template</Label>
            <select id="sandbox-template" value={template} onChange={(e) => setTemplate(e.target.value)} title={templates.find((t) => t.id === template)?.description}
              className="h-8 rounded-md border border-input bg-transparent px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring">
              {(templates.length ? templates : [{ id: "locked-down", name: "Locked down" }]).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>}

          {error && <p role="alert" className="rounded-md border border-red-200 bg-red-50/60 px-3 py-2 text-[11px] text-red-700">{error}</p>}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy || !name || group === null} className="bg-[var(--action)] text-[var(--action-foreground)] hover:bg-[var(--action)]/90">
              {busy && <Spinner aria-hidden="true" />}Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
