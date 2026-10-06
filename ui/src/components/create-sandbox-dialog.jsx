import { PolicyDialog, newPolicy } from "@/components/egress-policies"
import { groupNetworkPolicies } from "../../shared/group-network.js"
import { motion, useReducedMotion } from "motion/react"
import { useCompute } from "@/lib/compute"
import { setupTargetsFor } from '../../shared/setup-targets.js'
import { SetupPicker } from "@/components/setups-view"
import * as React from "react"
import { toast } from "sonner"
import { Check, ChevronDown, Terminal } from "lucide-react"
import { LocationChip, LocationStep, StepTrail } from "@/components/location-step"
import { FormSection } from "@/components/form-section"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { CopyCommand } from "@/components/copy-command"
import { GroupPicker } from "@/components/group-picker"
import { LocationProvider, useApi, useLocation } from "@/lib/location-context"
import { locationLabel } from "@/lib/locations"
import { persistentGateway } from "@/lib/sandbox-session"
import { LocationBadge } from "@/components/location-badge"
import { sandboxCreations } from "@/lib/sandbox-creations"
import { SANDBOX_ROOT, formatBytes, uploadCommand } from "@/lib/files"
import { AGENTS } from "@/lib/image-templates"
import { QUICK_AGENTS, quickRecipe, quickSession, compatibleProviders, prepareQuickTemplate, prepareQuickSetups } from "@/lib/quick-setup"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { AGENT_ACCESS, agentAccessFor, connectorAgents } from "../../shared/agent-access.js"

const locationKey = (location) => location?.id ?? location?.context
const PRIMARY_QUICK_AGENTS = ["claude", "codex", "cursor", "pi", "antigravity", "opencode"]
  .map((id) => QUICK_AGENTS.find((agent) => agent.id === id)).filter(Boolean)
const OTHER_QUICK_AGENTS = QUICK_AGENTS.filter((agent) => !PRIMARY_QUICK_AGENTS.includes(agent))

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
      <details className="mt-1">
        <summary className="cursor-pointer text-muted-foreground">Upload from a terminal instead</summary>
        {plan.git === "included" && <p className="mt-1 text-muted-foreground">Without git history.</p>}
        <CopyCommand command={uploadCommand(sandbox || "NAME", plan.display, SANDBOX_ROOT)} />
      </details>
    </div>
  )
}

// Which group the sandbox joins, and what network access that brings.
function GroupField({ org, value, onChange, onCreated, onAddPolicy, invalid = false }) {
  const reducedMotion = useReducedMotion()
  const reach = groupNetworkPolicies(org.policies, value)
  const counts = Object.fromEntries(org.groups.map((g) => [g.id, org.members?.[g.id]?.length ?? 0]))
  const chosen = org.groups.filter((g) => value.includes(g.id))
  return (
    <div id="sandbox-groups" className={`-m-3 rounded-lg p-3 transition-colors ${invalid ? "bg-destructive/5 ring-1 ring-destructive/60" : ""}`}>
    <fieldset aria-invalid={invalid || undefined} className="grid min-w-0 gap-2.5">
      <legend className="mb-2.5 text-xs font-medium">Groups <span className="text-muted-foreground">· Optional</span></legend>
      <GroupPicker multiple groups={org.groups} counts={counts} value={value} onChange={onChange} onCreated={onCreated} />
      <motion.p key={value.join(",") || "empty"} initial={reducedMotion ? false : { opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18 }} aria-live="polite" className={`text-[11px] leading-relaxed ${invalid ? "text-destructive" : "text-muted-foreground"}`}>
        {reach.length
          ? <>Gets {reach.length === 1 ? "this network rule" : `these ${reach.length} network rules`}: <span className="text-foreground">{reach.map((p) => p.name).join(", ")}</span>.</>
          : chosen.length ? <>No network rules yet: this sandbox starts locked down. Add a rule to allow more.</>
          : org.groups.length ? null
          : "Create a group to share network access between sandboxes. Network rules can then target the whole group."}
      </motion.p>
      {chosen.length > 0 && !reach.length && <Button type="button" variant="outline" size="sm" className="w-fit" onClick={onAddPolicy}>Add network rule</Button>}
    </fieldset>
    </div>
  )
}

// Names in use at this location, counting sandboxes still being created.
function takenNames(list, location) {
  const pending = sandboxCreations.getSnapshot().filter((job) => job.status !== "failed" && job.status !== "cancelled" && locationKey(job.location) === locationKey(location))
  return new Set([...list.map((sandbox) => sandbox.name), ...pending.map((job) => job.name)])
}

function nextName(taken, prefix = "sandbox") {
  for (let i = 1; i < 1000; i++) {
    const name = `${prefix}-${i}`
    if (!taken.has(name)) return name
  }
  return ""
}

export function CreateSandboxDialog({ locations, location: requestedLocation, onLocationChange, onRefreshLocations, allowRemote = false, initialLocationConfirmed = false, ...props }) {
  const inheritedLocation = useLocation()
  const api = useApi()
  const [selectedContext, setSelectedContext] = React.useState(null)
  const templateLocation = props.initialImageTemplate?.location
  const available = locations ?? []
  const owner = templateLocation ?? requestedLocation
  const location = owner
    ? available.find((item) => locationKey(item) === locationKey(owner)) ?? (locationKey(inheritedLocation) === locationKey(owner) ? inheritedLocation : owner)
    : available.find((item) => locationKey(item) === selectedContext) ?? inheritedLocation ?? available.find((item) => item.target === api.target && item.connected) ?? null
  // Every new sandbox starts by choosing where it runs, unless a template already decides that.
  const askWhere = !props.initialImageTemplate && (allowRemote || available.length > 1)
  const [step, setStep] = React.useState("where")
  const [pendingGateway, setPendingGateway] = React.useState(null)
  React.useEffect(() => {
    if (!props.open) setSelectedContext(null)
    setStep(initialLocationConfirmed ? "form" : "where"); setPendingGateway(null)
  }, [props.open, initialLocationConfirmed])
  const changeLocation = (context) => {
    const next = available.find((item) => locationKey(item) === context && item.connected)
    if (!next) return
    setSelectedContext(context)
    onLocationChange?.(next)
  }
  // A just-connected host appears in the inventory a moment later; continue as soon as it does.
  React.useEffect(() => {
    if (!pendingGateway) return
    const found = available.find((item) => item.gateway === pendingGateway && item.connected)
    if (found) { setPendingGateway(null); changeLocation(locationKey(found)); setStep("form"); return }
    const timer = setInterval(() => onRefreshLocations?.(), 1500)
    return () => clearInterval(timer)
  }, [pendingGateway, available])
  const chooser = askWhere && step === "where" ? <LocationStep locations={available} allowRemote={allowRemote} connecting={Boolean(pendingGateway)}
    onPick={(context) => { changeLocation(context); setStep("form") }}
    onConnected={(job) => { setPendingGateway(job.gateway); onRefreshLocations?.() }}
    onCancel={() => props.onOpenChange(false)} /> : null
  return <LocationProvider location={location}>
    <CreateSandboxForm key={locationKey(location) ?? "default"} {...props} locations={available} onLocationChange={changeLocation}
      chooser={chooser} onChangeLocation={askWhere ? () => setStep("where") : undefined} />
  </LocationProvider>
}

function CreateSandboxForm({ open, onOpenChange, onStarted, initialImageTemplate = null, locations, onLocationChange, chooser, onChangeLocation }) {
  const api = useApi()
  const location = useLocation()
  const reduceMotion = useReducedMotion()
  const [sandboxes, setSandboxes] = React.useState([])
  const [providers, setProviders] = React.useState([])
  const [name, setName] = React.useState("")
  const nameEdited = React.useRef(false)
  const [images, setImages] = React.useState([])
  const [setupIds, setSetupIds] = React.useState([])
  const [setupAccessReview, setSetupAccessReview] = React.useState(null)
  const [imageTemplate, setImageTemplate] = React.useState("")
  const [chosen, setChosen] = React.useState([])
  const [mode, setMode] = React.useState("quick")
  const [agentIds, setAgentIds] = React.useState([])
  const [openIn, setOpenIn] = React.useState("shell")
  const [quickProviders, setQuickProviders] = React.useState({})
  const [connectors, setConnectors] = React.useState([])
  const [error, setError] = React.useState(null)
  const [policyDraft, setPolicyDraft] = React.useState(null)
  const [start, setStart] = React.useState("empty")
  const compute = useCompute()
  const cloud = Boolean(location?.cloud || (location?.target ?? compute?.target) === "cloud")
  const [folder, setFolder] = React.useState("")
  const [preview, setPreview] = React.useState(null)
  const [repository, setRepository] = React.useState("")
  const [org, setOrg] = React.useState(null)
  const [group, setGroup] = React.useState([])
  const [localCatalog, setLocalCatalog] = React.useState(null)
  const [catalogLoading, setCatalogLoading] = React.useState(false)
  const [catalogAttempt, setCatalogAttempt] = React.useState(0)
  // Set by pressing Create while something is missing, so the missing fields turn red.
  const [showMissing, setShowMissing] = React.useState(false)

  // A fresh sandbox starts in Quick setup; launching a saved template opens its tab.
  React.useEffect(() => {
    if (!open || location?.connected === false) return
    let current = true
    nameEdited.current = false
    setSandboxes([]); setProviders([])
    api.overview().then((overview) => {
      if (!current) return
      const list = overview.sandboxes ?? []
      const savedProviders = overview.providers ?? []
      setSandboxes(list); setProviders(savedProviders)
      if (!nameEdited.current) setName(nextName(takenNames(list, location)))
      setChosen(savedProviders.map((provider) => provider.name))
    }).catch((e) => { if (current) setError(e.message) })
    setName("")
    setMode(initialImageTemplate ? "template" : "quick")
    setAgentIds([]); setOpenIn("shell"); setQuickProviders({}); setConnectors([])
    setSetupIds([])
    setImageTemplate(initialImageTemplate?.name || "")
    setImages(initialImageTemplate ? [initialImageTemplate] : [])
    api.imageTemplates().then((items) => { if (current) setImages(items.filter((t) => t.status === "ready" || t.exists)) }).catch((e) => { if (current) setError(e.message) })
    setChosen([])
    setError(null); setPolicyDraft(null); setOrg(null)
    setStart("empty"); setFolder(""); setPreview(null); setRepository("")
    setGroup([]); setShowMissing(false)
    setLocalCatalog(null); setCatalogLoading(persistentGateway(location))
    const catalog = persistentGateway(location) ? api.syncLocalCatalog() : Promise.resolve(null)
    catalog.then(async (copied) => {
      if (!current) return
      const value = await api.org()
      if (!current) return
      // Offer the latest local snapshot alongside remote-authored groups;
      // retained snapshots keep supporting their existing remote sandboxes.
      if (copied?.available) value.groups = value.groups.filter(g => !copied.importedGroups.includes(g.id) || copied.groups.includes(g.id))
      setOrg(value); setLocalCatalog(copied)
    }).catch((e) => { if (current) { setOrg(null); setError(`Could not load sandbox settings: ${e.message}`) } }).finally(() => { if (current) setCatalogLoading(false) })
    return () => { current = false }
  }, [open, api, location?.connected, location?.remote, initialImageTemplate, catalogAttempt])

  const chosenImage = mode === "template" ? images.find((t) => t.name === imageTemplate) : null
  const selectedAgents = QUICK_AGENTS.filter((agent) => agentIds.includes(agent.id))
  const attachedProviders = mode === "quick" ? [...new Set(selectedAgents.flatMap((agent) => {
    const chosenProvider = quickProviders[agent.id]
    return compatibleProviders(providers, agent.id).some((provider) => provider.name === chosenProvider) ? [chosenProvider] : []
  }))] : chosen
  const templateAgents = chosenImage?.managed && chosenImage.recipe.source === "build" ? AGENTS.filter((agent) => chosenImage.recipe.agents.includes(agent.id)) : null

  const setupAgentIds = mode === "quick" ? agentIds : (templateAgents ?? []).map((agent) => agent.id)
  // Connectors come with a subscription sign-in, so an attached API key rules them out.
  const keyed = mode === "quick" ? Object.keys(quickProviders).filter((id) => quickProviders[id]) : []
  const chosenConnectors = connectorAgents(setupAgentIds).filter((id) => connectors.includes(id) && !keyed.includes(id))
  const agentAccess = agentAccessFor(mode === "quick" ? quickRecipe(agentIds) : chosenImage?.managed ? chosenImage.recipe : null, { connectors: chosenConnectors })
  const setupTargets = setupTargetsFor(setupAgentIds)
  const hasSetups = mode === "quick" ? setupIds.length > 0 : Boolean(chosenImage?.recipe?.setups?.length)
  const missingSetupAgent = hasSetups && !setupTargets.length

  function toggleAgent(id) {
    const next = agentIds.includes(id) ? agentIds.filter((item) => item !== id) : [...agentIds, id]
    setAgentIds(next); setError(null)
    if (next.length !== 1 || !next.includes(openIn)) setOpenIn("shell")
    setQuickProviders((current) => Object.fromEntries(Object.entries(current).filter(([key]) => next.includes(key))))
    if (/^(sandbox|terminal|claude|codex|cursor|opencode|pi|antigravity|copilot|kiro|droid|aider)-\d+$/.test(name)) setName(nextName(takenNames(sandboxes ?? [], location), next.length === 1 ? next[0] : "sandbox"))
  }

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
  }, [start, folder, api])

  const groupReady = group.every((id) => org?.groups.some((g) => g.id === id))
  const cloneDest = start === "repo" ? repoDest(repository) : null
  const startReady = start === "empty" || (start === "folder" ? Boolean(preview?.data && !preview.data.over) : Boolean(cloneDest))

  const filesSummary = start === "folder" ? folder.trim() : start === "repo" ? repository.trim() : ""

  // The work runs in the background so the console stays usable; its
  // progress, build logs and result follow as a notification.
  function submit(event) {
    event.preventDefault()
    if (location?.connected === false) return
    const missing = [!name && "sandbox-name", mode === "template" && !chosenImage && "sandbox-image-template", !groupReady && "sandbox-groups"].find(Boolean)
    if (missing || !startReady || missingSetupAgent) {
      setShowMissing(true)
      if (missing) document.getElementById(missing)?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" })
      return
    }
    const files = start === "folder" ? { folder: preview.data.path } : start === "repo" ? { repository: repository.trim() } : {}
    const sandboxName = name.trim(), quick = mode === "quick", agents = agentIds, session = quick ? { session: quickSession(agentIds, openIn) } : {}
    const setups = setupIds, accessReview = setupAccessReview, chosenConnectorIds = chosenConnectors, providers = attachedProviders, targets = setupTargets, groups = group, template = chosenImage
    sandboxCreations.start({ name: sandboxName, location, task: async ({ signal, progress, build, creating }) => {
      let environment = template, launchSetupIds = [], launchAccessReview = null, buildName = null
      const cancelBuild = () => { if (buildName) void api.cancelImageBuild(buildName).catch((e) => toast.error(e.message)) }
      signal.addEventListener("abort", cancelBuild)
      try {
        if (quick) {
          const prepared = await prepareQuickSetups(api, setups, accessReview, { signal, onProgress: progress })
          launchSetupIds = prepared.setups.map(s => s.id)
          launchAccessReview = prepared.accessReview
          environment = await prepareQuickTemplate(api, agents, {
            withSetups: setups.length > 0, setups: prepared.setups, signal, onProgress: progress,
            onBuildUpdate: build,
            onBuild: (value) => { buildName = value; if (signal.aborted) cancelBuild() },
          })
        }
      } finally { signal.removeEventListener("abort", cancelBuild) }
      if (signal.aborted) throw new DOMException("Cancelled", "AbortError")
      creating()
      const created = await api.create({ name: sandboxName, imageTemplate: environment.name, includeTemplateAccess: !quick, ...session, providers, setups: launchSetupIds, setupAccessReview: launchAccessReview, setupTargets: targets, connectors: chosenConnectorIds, groups, ...files })
      if (created.seed) toast(`${created.seed.kind === "folder" ? "Uploading" : "Cloning"} ${created.seed.source}`, { description: `Into ${created.seed.dest} once the sandbox starts. Progress is in its Files tab.` })
      for (const door of created.opened ?? []) toast(`Opened ${door.name || "default"} on port ${door.port}`, { description: door.url ?? undefined })
      return { ...created, image: environment.image, providers, createdAt: new Date().toISOString(), ...(location ? { location } : {}) }
    } })
    onOpenChange(false)
    onStarted?.()
  }

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] gap-4 bg-transparent p-0 ring-0 sm:max-w-4xl">
        {chooser ?? <>
        <form onSubmit={submit} className={`@container flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl bg-popover ring-1 ring-foreground/10 max-h-[90svh]`}>
          <Tabs value={mode} onValueChange={(value) => { setMode(value); setError(null) }} className="contents">
          <DialogHeader className="shrink-0 gap-3 px-5 pt-5 pb-4 @3xl:px-7 @3xl:pt-6">
            {onChangeLocation && <div className="pr-8"><StepTrail step={2} /></div>}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pr-8">
              <DialogTitle>New sandbox</DialogTitle>
              {onChangeLocation ? <LocationChip location={location} onChange={onChangeLocation} /> : !initialImageTemplate && locations.length > 0 ? null : <LocationBadge location={location} />}
              <TabsList className="ml-auto w-fit" aria-label="Sandbox creation method">
                <TabsTrigger value="quick" className="px-3 text-xs">Quick setup</TabsTrigger>
                <TabsTrigger value="template" className="px-3 text-xs">From template</TabsTrigger>
              </TabsList>
            </div>
            {!onChangeLocation && locations.length > 0 && !initialImageTemplate && <div className="grid gap-1.5">
              <Label htmlFor="sandbox-location" className="text-xs">Location</Label>
              <Select value={locationKey(location) ?? ""} onValueChange={onLocationChange} items={locations.map((item) => ({ value: locationKey(item), label: `${locationLabel(item)}${!item.connected ? " · Disconnected" : ""}` }))}>
                <SelectTrigger id="sandbox-location" className="w-full text-xs"><SelectValue placeholder="Choose a connected location" /></SelectTrigger>
                <SelectContent align="start" alignItemWithTrigger={false}>{locations.map((item) => <SelectItem key={locationKey(item)} value={locationKey(item)} disabled={!item.connected}>{locationLabel(item)}{!item.connected ? " · Disconnected" : ""}</SelectItem>)}</SelectContent>
              </Select>
            </div>}
            {location?.connected === false && <p role="alert" className="text-xs text-destructive">This location is disconnected. Choose a connected location to create a sandbox.</p>}
            {catalogLoading && <p role="status" className="text-xs text-muted-foreground">Loading your local network policies, MCPs &amp; Skills, and Groups…</p>}
            {localCatalog?.available && <p className="text-xs text-muted-foreground">Your local network policies, MCPs &amp; Skills, and Groups are available here. Existing remote sandboxes keep their settings.</p>}
            {persistentGateway(location) && !catalogLoading && !org && <Button type="button" variant="outline" size="sm" className="w-fit" onClick={() => setCatalogAttempt(n => n + 1)}>Retry loading settings</Button>}
          </DialogHeader>

          <div className="grid min-h-0 flex-1 overflow-y-auto overscroll-contain border-t border-border @3xl:grid-cols-[minmax(0,1fr)_19rem] @3xl:overflow-hidden">
          <fieldset disabled={location?.connected === false} className="contents">
            <motion.div initial={reduceMotion ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
              className="grid min-w-0 content-start gap-6 p-5 @3xl:overflow-y-auto @3xl:p-7">
            <div className="grid gap-1.5">
              <Label htmlFor="sandbox-name" className="text-xs">Name</Label>
              <Input id="sandbox-name" value={name} onChange={(e) => { nameEdited.current = true; setName(e.target.value.toLowerCase()) }} className="h-10 font-mono text-sm" required aria-invalid={(showMissing && !name) || undefined}
                pattern="[a-z0-9]([a-z0-9\-]{0,17}[a-z0-9])?" maxLength={19} title="Lowercase letters, digits and dashes, up to 19" autoFocus />
            </div>

            <TabsContent value="quick" className="grid gap-4">
              <fieldset className="min-w-0">
                <legend className="mb-1.5 text-xs font-medium">Agents</legend>
                <div className="grid grid-cols-2 gap-2 @3xl:grid-cols-3">
                  {PRIMARY_QUICK_AGENTS.map((agent) => (
                    <label key={agent.id} className="relative min-w-0">
                      <input type="checkbox" checked={agentIds.includes(agent.id)} onChange={() => toggleAgent(agent.id)} className="peer sr-only" />
                      <span className="flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg border border-border bg-background px-3 py-2 text-xs transition-all hover:-translate-y-px hover:bg-muted/50 hover:shadow-sm motion-reduce:hover:translate-y-0 @3xl:min-h-14 peer-checked:border-foreground/40 peer-checked:bg-accent peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-disabled:pointer-events-none peer-disabled:opacity-50">
                        <img src={agent.logo} alt="" className="size-4 shrink-0 object-contain" />
                        <span className="min-w-0 flex-1">{agent.name}</span>
                        {agentIds.includes(agent.id) && <Check className="size-3.5 shrink-0" aria-hidden="true" />}
                      </span>
                    </label>
                  ))}
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger render={<Button type="button" variant="outline" className="mt-2 w-full justify-between text-xs" />}>
                    <span className="truncate">{OTHER_QUICK_AGENTS.filter((agent) => agentIds.includes(agent.id)).map((agent) => agent.name).join(", ") || "More agents"}</span>
                    <ChevronDown className="size-3.5 shrink-0" aria-hidden="true" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    {OTHER_QUICK_AGENTS.map((agent) => (
                      <DropdownMenuCheckboxItem key={agent.id} checked={agentIds.includes(agent.id)} onCheckedChange={() => toggleAgent(agent.id)} closeOnClick={false} className="text-xs">
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
                      <input type="radio" name="quick-open-in" value={option.id} checked={openIn === option.id} onChange={() => setOpenIn(option.id)} className="peer sr-only" />
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
                  <Label htmlFor={`quick-sign-in-${agent.id}`} className="text-xs">{agent.name} API key</Label>
                  <Select value={quickProviders[agent.id] || ""} onValueChange={(value) => setQuickProviders((current) => ({ ...current, [agent.id]: value ?? "" }))}>
                    <SelectTrigger id={`quick-sign-in-${agent.id}`} className="w-full text-xs"><SelectValue>{quickProviders[agent.id] || "None, I’ll use my subscription"}</SelectValue></SelectTrigger>
                    <SelectContent align="start" alignItemWithTrigger={false}><SelectGroup>
                      <SelectItem value="" className="text-xs">None, I’ll use my subscription</SelectItem>
                      {connections.map((provider) => <SelectItem key={provider.name} value={provider.name} className="text-xs">{provider.name}</SelectItem>)}
                    </SelectGroup></SelectContent>
                  </Select>
                </div>
              })}
              <ConnectorChoices agents={agentIds} keyed={keyed} value={connectors} onChange={setConnectors} />
            </TabsContent>
            <TabsContent value="template" className="grid gap-4">
              <div className="grid gap-1.5">
                <Label htmlFor="sandbox-image-template" className="text-xs">Environment</Label>
                <Select value={imageTemplate} onValueChange={(value) => setImageTemplate(value ?? "")}>
                  <SelectTrigger id="sandbox-image-template" aria-invalid={(showMissing && !chosenImage) || undefined} className="w-full text-xs"><SelectValue>{imageTemplate || "Choose a template"}</SelectValue></SelectTrigger>
                  <SelectContent align="start" alignItemWithTrigger={false}><SelectGroup>
                    {images.map((item) => <SelectItem key={item.name} value={item.name} className="text-xs">{item.name}</SelectItem>)}
                  </SelectGroup></SelectContent>
                </Select>
                {showMissing && !chosenImage && images.length > 0 && <p className="text-[11px] text-destructive">Choose a template to create a sandbox.</p>}
                {!images.length && <p className={`text-[11px] ${showMissing ? "text-destructive" : "text-muted-foreground"}`}>No ready templates. Use Quick setup or create one in Templates.</p>}
                {chosenImage && <p className="text-[11px] text-muted-foreground">{templateAgents ? `Included tools: ${[...templateAgents.map((agent) => agent.name), ...(chosenImage.recipe.customAgents ?? []).map((agent) => agent.name), "Terminal"].join(", ")}` : "Installed tools are not reported by this template."}</p>}
              </div>
              <ConnectorChoices agents={setupAgentIds} value={connectors} onChange={setConnectors} />
            </TabsContent>

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

            {error && <p role="alert" className="rounded-md border border-red-200 bg-red-50/60 px-3 py-2 text-[11px] text-red-700">{error}</p>}
            </motion.div>

            <motion.aside initial={reduceMotion ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, delay: 0.06, ease: [0.22, 1, 0.36, 1] }}
              className="grid min-w-0 content-start gap-6 border-t border-border bg-muted/25 p-5 @3xl:overflow-y-auto @3xl:border-t-0 @3xl:border-l @3xl:p-6">
            {org ? <GroupField org={org} value={group} onChange={setGroup} invalid={showMissing && !groupReady}
              onAddPolicy={() => setPolicyDraft(newPolicy({ appliesTo: { everyone: false, groups: group, sandboxes: [] } }))}
              onCreated={(g) => setOrg((o) => ({ ...o, groups: [...o.groups, g].sort((a, b) => a.name.localeCompare(b.name)), members: { ...o.members, [g.id]: [] } }))} />
              : <p role="status" className="text-xs text-muted-foreground">{error ? "Groups unavailable. Reopen this dialog to retry." : "Loading groups…"}</p>}

            {(mode === "quick" || (hasSetups && (missingSetupAgent || setupAgentIds.includes('aider')))) && <div className="space-y-3">
              {mode === "quick" && !catalogLoading && <SetupPicker localCatalog={localCatalog} autoPrepare automaticAccess preparationContext="sandbox" accessReview={setupAccessReview} onAccessReview={setSetupAccessReview} value={setupIds} onChange={setSetupIds} />}
              {hasSetups && missingSetupAgent && <p role="alert" className="text-xs text-destructive">
                {setupAgentIds.includes('aider') ? 'Setup installation is unavailable for Aider. Choose another agent.' : mode === "quick" ? 'Choose an agent to use this Setup.' : 'Choose a template with a supported agent to use this Setup.'}
              </p>}
              {hasSetups && !missingSetupAgent && setupAgentIds.includes('aider') && <p className="text-xs text-muted-foreground">Setup installation is unavailable for Aider.</p>}
            </div>}

            <div className="grid min-w-0">
              <FormSection title="Add project files" summary={filesSummary}>
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

              </FormSection>
                  {agentAccess.profiles.length > 0 && <FormSection title={agentAccess.profiles.some((profile) => profile.rule.startsWith("tool-")) ? "Agent and tool connections" : "Agent connections"} summary={`${new Set(agentAccess.profiles.flatMap((profile) => profile.endpoints.map((endpoint) => `${endpoint.host}:${endpoint.ports.join(",")}`))).size} destinations`}>
                    <div className="max-h-52 divide-y overflow-y-auto">
                      {agentAccess.profiles.map((profile) => <details key={profile.id} className="px-3 py-2">
                        <summary className="cursor-pointer text-xs">{profile.name}<span className="ml-2 text-[11px] text-muted-foreground">{profile.endpoints.length} destinations · {profile.rule}</span></summary>
                        <ul className="mt-2 space-y-1">
                          {profile.endpoints.map((endpoint) => <li key={endpoint.host} className="flex flex-wrap items-baseline justify-between gap-x-3 text-[11px]">
                            <span className="break-all font-mono">{endpoint.host}:{endpoint.ports.join(",")}</span>
                            <span className="text-muted-foreground">{endpoint.tlsSkip ? "TLS passthrough" : endpoint.allow?.length ? `${endpoint.allow.map((a) => a.method).join(", ")} only` : endpoint.access === "read-only" ? "Read only" : "Read & write"}{endpoint.deny?.length ? ` · ${endpoint.deny.length} paths blocked` : ""}</span>
                          </li>)}
                        </ul>
                        {profile.authentication && <p className="mt-2 text-[11px]">{profile.authentication}</p>}
                        <p className="mt-2 text-[11px] text-muted-foreground">Allowed programs</p>
                        <ul className="mt-1 space-y-1 break-all font-mono text-[10px] text-muted-foreground">{profile.binaries.map((binary) => <li key={binary}>{binary}</li>)}</ul>
                      </details>)}
                    </div>
                  </FormSection>}

            </div>
            </motion.aside>
          </fieldset>
          </div>

          <DialogFooter className="mx-0 mb-0 shrink-0 items-center rounded-none border-t border-border bg-popover px-5 py-4 @3xl:px-7">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={location?.connected === false} className="bg-[var(--action)] text-[var(--action-foreground)] hover:bg-[var(--action)]/90">Create sandbox</Button>
          </DialogFooter>
          </Tabs>
        </form>
        </>}
      </DialogContent>
    </Dialog>
    <PolicyDialog open={Boolean(policyDraft)} initial={policyDraft} onOpenChange={(value) => { if (!value) setPolicyDraft(null) }}
      groups={org?.groups ?? []} sandboxes={(sandboxes ?? []).map((s) => s.name)} assignments={org?.assignments ?? {}} onGroupCreated={(g) => setOrg((o) => ({ ...o, groups: [...o.groups, g] }))}
      onSaved={(result, policy) => {
        setGroup((current) => [...new Set([...current, ...policy.appliesTo.groups])])
        setOrg((o) => ({ ...o, policies: [...o.policies.filter((p) => p.id !== policy.id), policy] }))
        if (result.failed?.length) toast.error("Rule saved, but some sandboxes could not be updated.")
        else toast.success(`Saved ${policy.name}`)
      }} />
    </>
  )
}

// Connectors (remote MCPs) the agent's subscription account already has.
// Choosing them opens only the vendor's connector proxy for that agent.
function ConnectorChoices({ agents, keyed = [], value, onChange }) {
  const offered = connectorAgents(agents)
  if (!offered.length) return null
  return <fieldset className="min-w-0">
    <legend className="mb-1.5 text-xs font-medium">Connectors</legend>
    <div className="grid gap-2">
      {offered.map((id) => <label key={id} className="flex cursor-pointer items-center gap-2 text-xs has-disabled:cursor-default has-disabled:text-muted-foreground">
        <Checkbox disabled={keyed.includes(id)} checked={value.includes(id) && !keyed.includes(id)} onCheckedChange={(on) => onChange(on ? [...value, id] : value.filter((item) => item !== id))} />
        <span className="min-w-0 flex-1 truncate">Use my {AGENT_ACCESS[id].connectors.name}</span>
        {keyed.includes(id) && <span className="text-[11px]">Subscription only</span>}
      </label>)}
    </div>
  </fieldset>
}
