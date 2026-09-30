import * as React from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Spinner } from "@/components/ui/spinner"
import { CopyCommand } from "@/components/copy-command"
import { GroupPicker } from "@/components/group-picker"
import { api } from "@/lib/api"
import { SANDBOX_ROOT, formatBytes, uploadCommand } from "@/lib/files"
import { useLive } from "@/lib/live"
import { STARTS } from "@/lib/image-templates"
import { policiesFor } from "@/lib/groups"
import { agentAccessFor } from "../../shared/agent-access.js"

const PRESETS = [
  { id: "claude", label: "Claude Code", command: "claude" },
  { id: "shell", label: "Shell", command: "" },
  { id: "custom", label: "Custom", command: null },
]

const FILE_STARTS = [
  { id: "empty", label: "Empty" },
  { id: "folder", label: "Local folder" },
  { id: "repo", label: "Git repository" },
]

// Where the server will clone to; mirrors its naming rule.
function repoDest(url) {
  try {
    const parsed = new URL(url.trim())
    if (parsed.protocol !== "https:") return null
    const segment = parsed.pathname.split("/").filter(Boolean).pop()?.replace(/\.git$/, "")
    if (!segment) return null
    return `${SANDBOX_ROOT}/${/^[A-Za-z0-9]([A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$/.test(segment) ? segment : "repo"}`
  } catch { return null }
}

const FILTER = {
  gitignore: ".gitignore applied",
  "gitignore-empty": ".gitignore matched nothing, so everything is sent",
  none: "Not a git repository, so everything is sent",
}
const HISTORY = {
  included: (plan) => `git history included (${formatBytes(plan.gitBytes)})`,
  worktree: () => "Git worktree: history not included",
  subfolder: () => "Inside a repository: history not included",
  none: () => null,
}

function FolderSummary({ plan, sandbox }) {
  return (
    <div className="grid min-w-0 gap-1 text-[11px]">
      {plan.over
        ? <p className="text-red-700">Over {formatBytes(plan.limit)}. Add a .gitignore, or upload it from a terminal.</p>
        : <p>{plan.files.toLocaleString()} {plan.files === 1 ? "file" : "files"} · {formatBytes(plan.bytes)} → <span className="font-mono">{plan.dest}</span></p>}
      <p className="text-muted-foreground">{[FILTER[plan.filter], HISTORY[plan.git](plan), plan.links ? `${plan.links} ${plan.links === 1 ? "symlink" : "symlinks"} kept as links` : null].filter(Boolean).join(" · ")}</p>
      {plan.secretCount > 0 && (
        <p className="text-amber-700">
          May hold secrets: <span className="font-mono">{plan.secrets.join(", ")}</span>{plan.secretCount > plan.secrets.length ? ` and ${plan.secretCount - plan.secrets.length} more` : ""}. Add {plan.secretCount === 1 ? "it" : "them"} to .gitignore to leave {plan.secretCount === 1 ? "it" : "them"} out.
        </p>
      )}
      <p className="mt-1 text-muted-foreground">From a terminal{plan.git === "included" ? " (without git history)" : ""}:</p>
      <CopyCommand command={uploadCommand(sandbox || "NAME", plan.display, SANDBOX_ROOT)} />
    </div>
  )
}

// Which group the sandbox joins, and what network access that brings.
function GroupField({ org, value, onChange, onCreated, name }) {
  const reach = policiesFor(org.policies, { name, group: value })
  const counts = Object.fromEntries(org.groups.map((g) => [g.id, org.members?.[g.id]?.length ?? 0]))
  const chosen = org.groups.find((g) => g.id === value)
  return (
    <div className="grid gap-1.5">
      <span className="text-xs font-medium">Group</span>
      <GroupPicker groups={org.groups} counts={counts} value={value} onChange={onChange} onCreated={onCreated} />
      <p className="text-[11px] text-muted-foreground">
        {reach.length
          ? <>Gets {reach.length === 1 ? "this network rule" : `these ${reach.length} network rules`}: <span className="text-foreground">{reach.map((p) => p.name).join(", ")}</span>.</>
          : chosen ? <>No network rule targets {chosen.name} yet. Add one on the Network page, and it applies to every sandbox in the group.</>
          : org.groups.length ? "Groups let network rules follow sandboxes. You can change the group later on the Groups page."
          : "Create a group to share network access between sandboxes. Network rules can then target the whole group."}
      </p>
      {chosen?.template && <p className="text-[11px] text-amber-700">{chosen.name} sets the policy (<span className="font-mono">{chosen.template}</span>), which replaces the choice below.</p>}
    </div>
  )
}

function nextName(taken) {
  for (let i = 1; i < 1000; i++) {
    const name = `claude-${i}`
    if (!taken.has(name)) return name
  }
  return ""
}


export function CreateSandboxDialog({ open, onOpenChange, onCreated, initialImageTemplate = null }) {
  const { sandboxes, overview } = useLive()
  const providers = overview?.providers ?? []
  const [name, setName] = React.useState("")
  const [image, setImage] = React.useState("")
  const [images, setImages] = React.useState([])
  const [imageTemplate, setImageTemplate] = React.useState("")
  const [chosen, setChosen] = React.useState([])
  const [preset, setPreset] = React.useState("claude")
  const [custom, setCustom] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState(null)
  const [templates, setTemplates] = React.useState([])
  const [template, setTemplate] = React.useState("locked-down")
  const [start, setStart] = React.useState("empty")
  const [folder, setFolder] = React.useState("")
  const [preview, setPreview] = React.useState(null)
  const [repository, setRepository] = React.useState("")
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
    setImageTemplate(initialImageTemplate?.name || "")
    setImages(initialImageTemplate ? [initialImageTemplate] : [])
    api.imageTemplates().then((items) => setImages(items.filter((t) => t.status === "ready" || t.exists))).catch(() => {})
    setChosen(providers.map((p) => p.name))
    setPreset("claude"); setCustom(""); setError(null); setTemplate("locked-down")
    setStart("empty"); setFolder(""); setPreview(null); setRepository("")
    api.templates().then(setTemplates).catch(() => setTemplates([]))
    setGroup(null)
    api.org().then(setOrg).catch(() => setOrg(null))
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const command = preset === "custom" ? custom : PRESETS.find((p) => p.id === preset).command
  const chosenImage = images.find((t) => t.name === imageTemplate)
  const templateStart = chosenImage?.recipe.command ?? ""
  const agentAccess = agentAccessFor(chosenImage?.managed ? chosenImage.recipe : null)

  // The server reads the folder, so it can apply .gitignore and count what it will send.
  React.useEffect(() => {
    if (start !== "folder" || !folder.trim()) { setPreview(null); return }
    let cancelled = false
    setPreview({ loading: true })
    const timer = setTimeout(() => {
      api.localFolder(folder.trim())
        .then((data) => { if (!cancelled) setPreview({ data }) })
        .catch((e) => { if (!cancelled) setPreview({ error: e.message }) })
    }, 400)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [start, folder])

  // Groups from before the console managed them can pin the preset.
  const pinnedPreset = org?.groups.find((g) => g.id === group)?.template ?? null
  const cloneDest = start === "repo" ? repoDest(repository) : null
  const startReady = start === "empty" || (start === "folder" ? Boolean(preview?.data && !preview.data.over) : Boolean(cloneDest))

  async function submit(event) {
    event.preventDefault()
    setBusy(true); setError(null)
    try {
      const files = start === "folder" ? { folder: preview.data.path } : start === "repo" ? { repository: repository.trim() } : {}
      const created = await api.create({ name: name.trim(), ...(imageTemplate ? { imageTemplate } : { image: image.trim(), command: command.trim().split(/\s+/).filter(Boolean) }), providers: chosen, template, ...(group ? { group } : {}), ...files })
      toast.success(`Creating ${created.name}`)
      if (created.seed) toast(`${created.seed.kind === "folder" ? "Uploading" : "Cloning"} ${created.seed.source}`, { description: `Into ${created.seed.dest} once the sandbox starts. Progress is in its Files tab.` })
      for (const door of created.opened ?? []) toast(`Opened ${door.name || "default"} on port ${door.port}`, { description: door.url ?? undefined })
      onOpenChange(false)
      onCreated?.(created.name, { ...created, image: image.trim(), providers: chosen, createdAt: new Date().toISOString() })
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>New sandbox</DialogTitle>
          </DialogHeader>

          <div className="grid gap-1.5">
            <Label htmlFor="sandbox-name" className="text-xs">Name</Label>
            <Input id="sandbox-name" value={name} onChange={(e) => setName(e.target.value.toLowerCase())} className="font-mono text-xs" required
              pattern="[a-z0-9]([a-z0-9\-]{0,17}[a-z0-9])?" maxLength={19} title="Lowercase letters, digits and dashes, up to 19" autoFocus />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="sandbox-image-template" className="text-xs">Image template</Label>
            <select id="sandbox-image-template" value={imageTemplate} onChange={(e) => setImageTemplate(e.target.value)} className="h-8 rounded-md border border-input bg-transparent px-2 text-xs">
              <option value="">Use an image reference</option>
              {images.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
            </select>
            {imageTemplate && <p className="text-[11px] text-muted-foreground">Starts in {STARTS.find((s) => s.id === templateStart)?.name ?? templateStart}. Software and environment only; access is selected below.</p>}
          </div>
          {!imageTemplate && <div className="grid gap-1.5">
            <Label htmlFor="sandbox-image" className="text-xs">Image reference</Label>
            <Input id="sandbox-image" value={image} onChange={(e) => setImage(e.target.value)} className="font-mono text-xs" placeholder="Default" title="Local images need Docker running" />
          </div>}

          {!imageTemplate && <div className="grid gap-1.5">
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
          </div>}

          <div className="grid min-w-0 gap-1.5">
            <span className="text-xs font-medium">Start with</span>
            <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
              {FILE_STARTS.map((s) => (
                <button key={s.id} type="button" onClick={() => setStart(s.id)} aria-pressed={start === s.id}
                  className={`flex-1 rounded px-2.5 py-1 text-[11px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${start === s.id ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
                  {s.label}
                </button>
              ))}
            </div>
            {start === "folder" && (
              <>
                <Input value={folder} onChange={(e) => setFolder(e.target.value)} className="font-mono text-xs" placeholder="~/code/my-project" aria-label="Folder on this computer" />
                {preview?.loading && <p className="text-[11px] text-muted-foreground">Checking the folder…</p>}
                {preview?.error && <p className="text-[11px] text-red-700">{preview.error}</p>}
                {preview?.data && <FolderSummary plan={preview.data} sandbox={name} />}
              </>
            )}
            {start === "repo" && (
              <>
                <Input value={repository} onChange={(e) => setRepository(e.target.value)} className="font-mono text-xs" placeholder="https://github.com/org/repo" aria-label="Git repository URL" />
                <p className="text-[11px] text-muted-foreground">
                  {cloneDest ? <>Cloned into <span className="font-mono">{cloneDest}</span> once the sandbox starts. </> : "An https:// URL. "}
                  Public repositories only. The policy must let git reach the host, including POST to /git-upload-pack.
                </p>
              </>
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
            {(imageTemplate ? templateStart === "claude" : preset === "claude") && !agentAccess.profiles.some((p) => p.id === "claude") && template !== "claude-subscription" && !chosen.some((n) => providers.find((p) => p.name === n)?.type === "claude-code") && (
              <p className="text-[11px] text-amber-700">Choose the Claude Code subscription policy or attach a claude-code provider.</p>
            )}
          </div>

          {org && <GroupField org={org} value={group} onChange={setGroup} name={name}
            onCreated={(g) => setOrg((o) => ({ ...o, groups: [...o.groups, g].sort((a, b) => a.name.localeCompare(b.name)), members: { ...o.members, [g.id]: [] } }))} />}

          <div className="grid gap-1.5">
            <Label htmlFor="sandbox-template" className="text-xs">Policy</Label>
            <select id="sandbox-template" value={pinnedPreset || template} onChange={(e) => setTemplate(e.target.value)} disabled={Boolean(pinnedPreset)} title={templates.find((t) => t.id === (pinnedPreset || template))?.description}
              className="h-8 rounded-md border border-input bg-transparent px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring">
              {(templates.length ? templates : [{ id: "locked-down", name: "Locked down" }]).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              {pinnedPreset && !templates.some((t) => t.id === pinnedPreset) && <option value={pinnedPreset}>{pinnedPreset}</option>}
            </select>
            <p className="text-[11px] text-muted-foreground">{templates.find((t) => t.id === (pinnedPreset || template))?.description || "Filesystem and network access."} Shared rules still apply.</p>
            {agentAccess.profiles.length > 0 && <div className="mt-2 rounded-md border border-border">
              <div className="border-b px-3 py-2">
                <p className="text-xs font-medium">Agent default rules</p>
                <p className="mt-1 text-[11px] text-muted-foreground">Added to the selected policy, including Locked down. These destinations allow agent sign-in and model connections; credentials may still be required.</p>
              </div>
              <div className="max-h-52 divide-y overflow-y-auto">
                {agentAccess.profiles.map((profile) => <details key={profile.id} className="px-3 py-2">
                  <summary className="cursor-pointer text-xs">{profile.name}<span className="ml-2 text-[11px] text-muted-foreground">{profile.endpoints.length} destinations · agent-{profile.id}</span></summary>
                  <ul className="mt-2 space-y-1">
                    {profile.endpoints.map((endpoint) => <li key={endpoint.host} className="flex flex-wrap items-baseline justify-between gap-x-3 text-[11px]">
                      <span className="break-all font-mono">{endpoint.host}:{endpoint.ports.join(",")}</span>
                      <span className="text-muted-foreground">{endpoint.tlsSkip ? "TLS passthrough" : endpoint.access === "read-only" ? "Read only" : "Read & write"}</span>
                    </li>)}
                  </ul>
                  {profile.authentication && <p className="mt-2 text-[11px]">{profile.authentication}</p>}
                  <p className="mt-2 text-[11px] text-muted-foreground">Allowed programs</p>
                  <ul className="mt-1 space-y-1 break-all font-mono text-[10px] text-muted-foreground">{profile.binaries.map((binary) => <li key={binary}>{binary}</li>)}</ul>
                </details>)}
              </div>
            </div>}
          </div>

          {error && <p role="alert" className="rounded-md border border-red-200 bg-red-50/60 px-3 py-2 text-[11px] text-red-700">{error}</p>}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy || !name || !startReady} className="bg-[var(--action)] text-[var(--action-foreground)] hover:bg-[var(--action)]/90">
              {busy && <Spinner aria-hidden="true" />}Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
