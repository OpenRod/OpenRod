import { useCloudMode } from "./auth-gate"
import { setupTargetsFor } from '../../shared/setup-targets.js'
import { SetupPicker } from "@/components/setups-view"
import * as React from "react"
import { toast } from "sonner"
import { Check, ChevronDown, ChevronRight, Info, Terminal } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { Spinner } from "@/components/ui/spinner"
import { CopyCommand } from "@/components/copy-command"
import { GroupPicker } from "@/components/group-picker"
import { api } from "@/lib/api"
import { SANDBOX_ROOT, formatBytes, uploadCommand } from "@/lib/files"
import { useLive } from "@/lib/live"
import { AGENTS } from "@/lib/image-templates"
import { QUICK_AGENTS, quickRecipe, quickSession, compatibleProviders, prepareQuickTemplate, prepareQuickSetups } from "@/lib/quick-setup"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { policiesFor } from "@/lib/groups"
import { agentAccessFor } from "../../shared/agent-access.js"

const PRIMARY_QUICK_AGENTS = ["claude", "codex", "cursor", "pi", "antigravity", "opencode"]
  .map((id) => QUICK_AGENTS.find((agent) => agent.id === id)).filter(Boolean)
const OTHER_QUICK_AGENTS = QUICK_AGENTS.filter((agent) => !PRIMARY_QUICK_AGENTS.includes(agent))

const FILE_STARTS = [
  { id: "empty", label: "Empty" },
  { id: "folder", label: "Local folder" },
  { id: "repo", label: "Git repository" },
]

function SetupSection({ title, summary, children, ...props }) {
  return (
    <details className="group/setup min-w-0 border-t border-border" {...props}>
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-sm py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open/setup:rotate-90" aria-hidden="true" />
        <span className="shrink-0 text-xs font-medium">{title}</span>
        <span className="ml-auto truncate text-right text-[11px] text-muted-foreground" title={summary}>{summary}</span>
      </summary>
      <div className="grid min-w-0 gap-4 pb-4 pt-1">{children}</div>
    </details>
  )
}

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
      <details className="mt-1">
        <summary className="cursor-pointer text-muted-foreground">Upload from a terminal instead</summary>
        {plan.git === "included" && <p className="mt-1 text-muted-foreground">Without git history.</p>}
        <CopyCommand command={uploadCommand(sandbox || "NAME", plan.display, SANDBOX_ROOT)} />
      </details>
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

function nextName(taken, prefix = "sandbox") {
  for (let i = 1; i < 1000; i++) {
    const name = `${prefix}-${i}`
    if (!taken.has(name)) return name
  }
  return ""
}

export function CreateSandboxDialog({ open, onOpenChange, onCreated, initialImageTemplate = null }) {
  const { sandboxes, overview } = useLive()
  const providers = overview?.providers ?? []
  const [name, setName] = React.useState("")
  const [images, setImages] = React.useState([])
  const [setupIds, setSetupIds] = React.useState([])
  const [setupAccessReview, setSetupAccessReview] = React.useState(null)
  const [imageTemplate, setImageTemplate] = React.useState("")
  const [chosen, setChosen] = React.useState([])
  const [mode, setMode] = React.useState("quick")
  const [agentIds, setAgentIds] = React.useState([])
  const [openIn, setOpenIn] = React.useState("shell")
  const [quickProviders, setQuickProviders] = React.useState({})
  const [progress, setProgress] = React.useState("")
  const [preparing, setPreparing] = React.useState(false)
  const preparation = React.useRef(null)
  const buildName = React.useRef(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState(null)
  const [templates, setTemplates] = React.useState([])
  const [template, setTemplate] = React.useState("locked-down")
  const [start, setStart] = React.useState("empty")
  const cloud = useCloudMode()
  const [folder, setFolder] = React.useState("")
  const [preview, setPreview] = React.useState(null)
  const [repository, setRepository] = React.useState("")
  const [org, setOrg] = React.useState(null)
  const [group, setGroup] = React.useState(null)

  // A fresh sandbox starts in Quick setup; launching a saved template opens its tab.
  React.useEffect(() => {
    if (!open) return
    const list = sandboxes ?? []
    setName(nextName(new Set(list.map((s) => s.name))))
    setMode(initialImageTemplate ? "template" : "quick")
    setAgentIds([]); setOpenIn("shell"); setQuickProviders({}); setProgress("")
    setSetupIds([])
    setImageTemplate(initialImageTemplate?.name || "")
    setImages(initialImageTemplate ? [initialImageTemplate] : [])
    api.imageTemplates().then((items) => setImages(items.filter((t) => t.status === "ready" || t.exists))).catch(() => {})
    setChosen(providers.map((p) => p.name))
    setError(null); setTemplate("locked-down")
    setStart("empty"); setFolder(""); setPreview(null); setRepository("")
    api.templates().then(setTemplates).catch(() => setTemplates([]))
    setGroup(null)
    api.org().then(setOrg).catch(() => setOrg(null))
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const chosenImage = mode === "template" ? images.find((t) => t.name === imageTemplate) : null
  const selectedAgents = QUICK_AGENTS.filter((agent) => agentIds.includes(agent.id))
  const agentAccess = agentAccessFor(mode === "quick" ? quickRecipe(agentIds) : chosenImage?.managed ? chosenImage.recipe : null)
  const attachedProviders = mode === "quick" ? [...new Set(selectedAgents.flatMap((agent) => {
    const chosenProvider = quickProviders[agent.id]
    return compatibleProviders(providers, agent.id).some((provider) => provider.name === chosenProvider) ? [chosenProvider] : []
  }))] : chosen
  const templateAgents = chosenImage?.managed && chosenImage.recipe.source === "build" ? AGENTS.filter((agent) => chosenImage.recipe.agents.includes(agent.id)) : null

  const setupAgentIds = mode === "quick" ? agentIds : (templateAgents ?? []).map((agent) => agent.id)
  const setupTargets = setupTargetsFor(setupAgentIds)
  const hasSetups = mode === "quick" ? setupIds.length > 0 : Boolean(chosenImage?.recipe?.setups?.length)
  const missingSetupAgent = hasSetups && !setupTargets.length

  function toggleAgent(id) {
    const next = agentIds.includes(id) ? agentIds.filter((item) => item !== id) : [...agentIds, id]
    setAgentIds(next); setError(null)
    if (next.length !== 1 || !next.includes(openIn)) setOpenIn("shell")
    setQuickProviders((current) => Object.fromEntries(Object.entries(current).filter(([key]) => next.includes(key))))
    if (/^(sandbox|terminal|claude|codex|cursor|opencode|pi|antigravity|copilot|kiro|droid|aider)-\d+$/.test(name)) setName(nextName(new Set((sandboxes ?? []).map((s) => s.name)), next.length === 1 ? next[0] : "sandbox"))
  }

  React.useEffect(() => () => { preparation.current?.abort() }, [])

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

  const effectivePreset = pinnedPreset || template
  const securityName = templates.find((t) => t.id === effectivePreset)?.name || (effectivePreset === "locked-down" ? "Locked down" : effectivePreset)
  const filesSummary = start === "folder" ? folder.trim() : start === "repo" ? repository.trim() : ""

  async function submit(event) {
    event.preventDefault()
    if (busy || missingSetupAgent || (mode === "template" && !chosenImage)) return
    setBusy(true); setError(null); setProgress("")
    const controller = new AbortController()
    preparation.current = controller
    buildName.current = null
    try {
      const files = start === "folder" ? { folder: preview.data.path } : start === "repo" ? { repository: repository.trim() } : {}
      let environment = chosenImage
      let launchSetupIds = [], launchAccessReview = null
      setPreparing(true)
      if (mode === "quick") {
        const prepared = await prepareQuickSetups(api, setupIds, setupAccessReview, { signal: controller.signal, onProgress: setProgress })
        launchSetupIds = prepared.setups.map(s => s.id)
        launchAccessReview = prepared.accessReview
        environment = await prepareQuickTemplate(api, agentIds, {
          withSetups: setupIds.length > 0, setups: prepared.setups, signal: controller.signal, onProgress: setProgress,
          onBuild: (value) => {
            buildName.current = value
            if (controller.signal.aborted) void api.cancelImageBuild(value).catch(() => {})
          },
        })
      }
      if (controller.signal.aborted) return
      setPreparing(false); setProgress("Creating sandbox…")
      const created = await api.create({ name: name.trim(), imageTemplate: environment.name, includeTemplateAccess: mode === "template", ...(mode === "quick" ? { session: quickSession(agentIds, openIn) } : {}), providers: attachedProviders, template, setups: launchSetupIds, setupAccessReview: launchAccessReview, setupTargets, ...(group ? { group } : {}), ...files })
      toast.success(`Creating ${created.name}`)
      if (created.seed) toast(`${created.seed.kind === "folder" ? "Uploading" : "Cloning"} ${created.seed.source}`, { description: `Into ${created.seed.dest} once the sandbox starts. Progress is in its Files tab.` })
      for (const door of created.opened ?? []) toast(`Opened ${door.name || "default"} on port ${door.port}`, { description: door.url ?? undefined })
      onOpenChange(false)
      onCreated?.(created.name, { ...created, image: environment.image, providers: attachedProviders, createdAt: new Date().toISOString() })
    } catch (e) {
      if (e.name !== "AbortError") setError(e.message)
    } finally {
      setBusy(false); setPreparing(false); setProgress(""); preparation.current = null; buildName.current = null
    }
  }

  return (
    <Dialog open={open} onOpenChange={(value) => { if (!busy) onOpenChange(value) }}>
      <DialogContent showCloseButton={!busy} className="max-h-[90svh] overflow-hidden sm:max-w-md">
        <form onSubmit={submit} className="flex max-h-[calc(90svh-2rem)] min-h-0 flex-col gap-4">
          <DialogHeader className="shrink-0">
            <DialogTitle>New sandbox</DialogTitle>
          </DialogHeader>

          <Tabs value={mode} onValueChange={(value) => { if (!busy) { setMode(value); setError(null) } }} className="contents">
            <TabsList className="w-full shrink-0" aria-label="Sandbox creation method">
              <TabsTrigger value="quick" disabled={busy}>Quick setup</TabsTrigger>
              <TabsTrigger value="template" disabled={busy}>From template</TabsTrigger>
            </TabsList>
          <div className="-mx-1 min-h-0 flex-1 overflow-y-auto overscroll-contain px-1">
          <fieldset disabled={busy} className="grid min-w-0 gap-4 pb-3">

            <div className="grid gap-1.5">
              <Label htmlFor="sandbox-name" className="text-xs">Name</Label>
              <Input id="sandbox-name" value={name} onChange={(e) => setName(e.target.value.toLowerCase())} className="font-mono text-xs" required
                pattern="[a-z0-9]([a-z0-9\-]{0,17}[a-z0-9])?" maxLength={19} title="Lowercase letters, digits and dashes, up to 19" autoFocus />
            </div>

            <TabsContent value="quick" className="grid gap-4">
              <fieldset className="min-w-0">
                <legend className="mb-1.5 text-xs font-medium">Agents</legend>
                <div className="grid grid-cols-2 gap-2">
                  {PRIMARY_QUICK_AGENTS.map((agent) => (
                    <label key={agent.id} className="relative min-w-0">
                      <input type="checkbox" checked={agentIds.includes(agent.id)} onChange={() => toggleAgent(agent.id)} disabled={busy} className="peer sr-only" />
                      <span className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-xs transition-colors hover:bg-muted/50 peer-checked:border-foreground/40 peer-checked:bg-accent peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-disabled:pointer-events-none peer-disabled:opacity-50">
                        <img src={agent.logo} alt="" className="size-4 shrink-0 object-contain" />
                        <span className="min-w-0 flex-1">{agent.name}</span>
                        {agentIds.includes(agent.id) && <Check className="size-3.5 shrink-0" aria-hidden="true" />}
                      </span>
                    </label>
                  ))}
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger render={<Button type="button" variant="outline" disabled={busy} className="mt-2 w-full justify-between text-xs" />}>
                    <span className="truncate">{OTHER_QUICK_AGENTS.filter((agent) => agentIds.includes(agent.id)).map((agent) => agent.name).join(", ") || "More agents"}</span>
                    <ChevronDown className="size-3.5 shrink-0" aria-hidden="true" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    {OTHER_QUICK_AGENTS.map((agent) => (
                      <DropdownMenuCheckboxItem key={agent.id} checked={agentIds.includes(agent.id)} onCheckedChange={() => toggleAgent(agent.id)} closeOnClick={false} disabled={busy} className="text-xs">
                        <img src={agent.logo} alt="" className="size-4 shrink-0 object-contain" />
                        {agent.name}
                      </DropdownMenuCheckboxItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </fieldset>
              {selectedAgents.length > 0 && <fieldset className="min-w-0">
                <legend className="mb-1.5 text-xs font-medium">Open in</legend>
                <div className="grid grid-cols-2 gap-2">
                  {[{ id: "shell", name: "Shell" }, ...(selectedAgents.length === 1 ? selectedAgents : [])].map((option) => (
                    <label key={option.id} className="relative min-w-0">
                      <input type="radio" name="quick-open-in" value={option.id} checked={openIn === option.id} onChange={() => setOpenIn(option.id)} disabled={busy} className="peer sr-only" />
                      <span className="flex min-h-16 cursor-pointer items-center gap-2.5 rounded-lg border border-border bg-background px-3 py-3 text-xs transition-colors hover:bg-muted/50 peer-checked:border-foreground/40 peer-checked:bg-accent peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-disabled:pointer-events-none peer-disabled:opacity-50">
                        {option.id === "shell" ? <Terminal className="size-5 shrink-0" aria-hidden="true" /> : <img src={option.logo} alt="" className="size-5 shrink-0 object-contain" />}
                        <span className="min-w-0 flex-1 font-medium">{option.name}</span>
                        <span aria-hidden="true" className={`flex size-3.5 shrink-0 items-center justify-center rounded-full border ${openIn === option.id ? "border-foreground" : "border-muted-foreground/40"}`}>
                          {openIn === option.id && <span className="size-1.5 rounded-full bg-foreground" />}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>}
              {selectedAgents.map((agent) => {
                const connections = compatibleProviders(providers, agent.id)
                if (!connections.length) return null
                return <div key={agent.id} className="grid gap-1.5">
                  <Label htmlFor={`quick-sign-in-${agent.id}`} className="text-xs">{agent.name} sign-in</Label>
                  <Select value={quickProviders[agent.id] || ""} onValueChange={(value) => setQuickProviders((current) => ({ ...current, [agent.id]: value ?? "" }))} disabled={busy}>
                    <SelectTrigger id={`quick-sign-in-${agent.id}`} className="w-full text-xs"><SelectValue>{quickProviders[agent.id] || "Set up after creation"}</SelectValue></SelectTrigger>
                    <SelectContent align="start" alignItemWithTrigger={false}><SelectGroup>
                      <SelectItem value="" className="text-xs">Set up after creation</SelectItem>
                      {connections.map((provider) => <SelectItem key={provider.name} value={provider.name} className="text-xs">{provider.name}</SelectItem>)}
                    </SelectGroup></SelectContent>
                  </Select>
                </div>
              })}
            </TabsContent>
            <TabsContent value="template" className="grid gap-4">
              <div className="grid gap-1.5">
                <Label htmlFor="sandbox-image-template" className="text-xs">Environment</Label>
                <Select value={imageTemplate} onValueChange={(value) => setImageTemplate(value ?? "")} disabled={busy}>
                  <SelectTrigger id="sandbox-image-template" className="w-full text-xs"><SelectValue>{imageTemplate || "Choose a template"}</SelectValue></SelectTrigger>
                  <SelectContent align="start" alignItemWithTrigger={false}><SelectGroup>
                    {images.map((item) => <SelectItem key={item.name} value={item.name} className="text-xs">{item.name}</SelectItem>)}
                  </SelectGroup></SelectContent>
                </Select>
                {!images.length && <p className="text-[11px] text-muted-foreground">No ready templates. Use Quick setup or create one in Templates.</p>}
                {chosenImage && <p className="text-[11px] text-muted-foreground">{templateAgents ? `Included tools: ${[...templateAgents.map((agent) => agent.name), ...(chosenImage.recipe.customAgents ?? []).map((agent) => agent.name), "Terminal"].join(", ")}` : "Installed tools are not reported by this template."}</p>}
              </div>
            </TabsContent>

            {(mode === "quick" || (hasSetups && (missingSetupAgent || setupAgentIds.includes('aider')))) && <div className="space-y-3 border-t pt-4">
              {mode === "quick" && <SetupPicker autoPrepare automaticAccess preparationContext="sandbox" accessReview={setupAccessReview} onAccessReview={setSetupAccessReview} value={setupIds} onChange={setSetupIds} />}
              {hasSetups && missingSetupAgent && <p role="alert" className="text-xs text-destructive">
                {setupAgentIds.includes('aider') ? 'Setup installation is unavailable for Aider. Choose another agent.' : mode === "quick" ? 'Choose an agent to use this Setup.' : 'Choose a template with a supported agent to use this Setup.'}
              </p>}
              {hasSetups && !missingSetupAgent && setupAgentIds.includes('aider') && <p className="text-xs text-muted-foreground">Setup installation is unavailable for Aider.</p>}
            </div>}

            {mode === "template" && <div className="grid gap-1.5">
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

            </div>}

            <div className="grid gap-1.5">
              <div className="flex items-center gap-1.5">
                <Label htmlFor="sandbox-template" className="text-xs">Policy</Label>
                <Tooltip>
                  <TooltipTrigger type="button" aria-label="About this policy" className="rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"><Info className="size-3.5" aria-hidden="true" /></TooltipTrigger>
                  <TooltipContent>{templates.find((t) => t.id === effectivePreset)?.description || "Filesystem and network access."} Shared rules still apply.</TooltipContent>
                </Tooltip>
              </div>
              <Select value={effectivePreset} onValueChange={(value) => { if (value) setTemplate(value) }} disabled={busy || Boolean(pinnedPreset)}>
                <SelectTrigger id="sandbox-template" className="w-full text-xs">
                  <SelectValue className="min-w-0 truncate">{securityName}</SelectValue>
                </SelectTrigger>
                <SelectContent align="start" alignItemWithTrigger={false}>
                  <SelectGroup>
                    {(templates.length ? templates : [{ id: "locked-down", name: "Locked down" }]).map((t) => <SelectItem key={t.id} value={t.id} className="text-xs">{t.name}</SelectItem>)}
                    {pinnedPreset && !templates.some((t) => t.id === pinnedPreset) && <SelectItem value={pinnedPreset} className="text-xs">{pinnedPreset}</SelectItem>}
                  </SelectGroup>
                </SelectContent>
              </Select>

            </div>


            <div className="grid min-w-0">
              <SetupSection title="Add project files" summary={filesSummary}>
                <div className="grid min-w-0 gap-1.5">
                  <span className="text-xs font-medium">Start with</span>
                  <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
                    {FILE_STARTS.filter((s) => !cloud || s.id !== "folder").map((s) => (
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
                        Public repositories only. Your access rules must allow Git connections to this host.
                      </p>
                    </>
                  )}
                </div>

              </SetupSection>
                  {agentAccess.profiles.length > 0 && <SetupSection title="Network rules" summary={`${new Set(agentAccess.profiles.flatMap((profile) => profile.endpoints.map((endpoint) => `${endpoint.host}:${endpoint.ports.join(",")}`))).size} destinations`}>
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
                  </SetupSection>}
                {org && <SetupSection title="Advanced options" summary={org.groups.find((item) => item.id === group)?.name}><GroupField org={org} value={group} onChange={setGroup} name={name}
                  onCreated={(g) => setOrg((o) => ({ ...o, groups: [...o.groups, g].sort((a, b) => a.name.localeCompare(b.name)), members: { ...o.members, [g.id]: [] } }))} /></SetupSection>}
            </div>

            {error && <p role="alert" className="rounded-md border border-red-200 bg-red-50/60 px-3 py-2 text-[11px] text-red-700">{error}</p>}

          </fieldset>
          </div>

          </Tabs>
          {progress && <p role="status" className="text-xs text-muted-foreground">{progress}</p>}
          <DialogFooter className="mx-0 mb-0 shrink-0 rounded-none bg-popover px-0 pb-0">
            <Button type="button" variant="ghost" disabled={busy && !preparing} onClick={() => {
              if (preparing) {
                preparation.current?.abort()
                if (buildName.current) void api.cancelImageBuild(buildName.current).catch((e) => toast.error(e.message))
              } else onOpenChange(false)
            }}>{preparing ? "Cancel preparation" : "Cancel"}</Button>
            <Button type="submit" disabled={busy || !name || !startReady || missingSetupAgent || (mode === "template" && !chosenImage)} className="bg-[var(--action)] text-[var(--action-foreground)] hover:bg-[var(--action)]/90">
              {busy && <Spinner aria-hidden="true" />}{busy ? preparing ? "Preparing…" : "Creating…" : "Create sandbox"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
