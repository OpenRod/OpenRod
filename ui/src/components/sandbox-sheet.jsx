import { SetupsView } from "@/components/setups-view"
import { useCloudMode } from "./auth-gate"
import * as React from "react"
import { AlertTriangle, Box, Copy, Globe, Play, Square, SquareCode, SquareTerminal, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Spinner } from "@/components/ui/spinner"
import { AuditLine } from "@/components/audit-line"
import { CopyCommand } from "@/components/copy-command"
import { ContinueInCloud, ContinueLocally } from "@/components/cloud-transfer"
import { FilesView } from "@/components/files-view"
import { useApi, useLocation } from "@/lib/location-context"
import { LocationBadge } from "@/components/location-badge"
import { LiveProvider, useLive } from "@/lib/live"
import { sessionName, terminalHref } from "@/lib/sandbox-session"
import { absoluteTime } from "@/lib/format"
import { ownerOf, PHASE_LABEL, canStart, canStop, commandText, imageName, statusOf, styleOf } from "@/lib/sandboxes"

import { EgressChart, bucketEgress } from "@/components/egress-chart"
import { agentsOf, agentInventoryLabel } from "@/lib/agents"
import { AgentList } from "@/components/agent-label"
import { Perimeter } from "@/components/perimeter"
import { displayName, hostOf, sourceOf } from "@/lib/policy-sources"

function Section({ title, icon: Icon, children, aside, className }) {
  return (
    <section className={className}>
      <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium text-foreground">
        {Icon && <Icon className="size-3" aria-hidden="true" />}{title}
        {aside && <span className="ml-auto font-normal normal-case tracking-normal">{aside}</span>}
      </h3>
      {children}
    </section>
  )
}

function useEditors() {
  const api = useApi()
  const cloud = useCloudMode()
  const [editors, setEditors] = React.useState([])
  React.useEffect(() => {
    if (cloud) return
    let cancelled = false
    let timer
    let editorsRequest
    const load = () => {
      editorsRequest ??= api.editors().then((list) => list.filter((editor) => editor.installed))
      editorsRequest.then((list) => { if (!cancelled) setEditors(list) })
        .catch(() => { editorsRequest = undefined; if (!cancelled) timer = setTimeout(load, 3000) })
    }
    load()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [cloud, api])
  return editors
}

// Cloud sandboxes have no local SSH or editors, so only the browser terminal applies.
function OpenIn({ name, editors, cloud, context }) {
  const api = useApi()
  const [connection, setConnection] = React.useState(null)
  const [error, setError] = React.useState(null)
  const [mode, setMode] = React.useState("ssh")
  const [opening, setOpening] = React.useState(false)
  const [loadingConfig, setLoadingConfig] = React.useState(false)
  const [config, setConfig] = React.useState(null)

  React.useEffect(() => {
    if (cloud) return
    let cancelled = false
    setConnection(null); setError(null); setMode("ssh"); setConfig(null)
    api.sshConnection(name)
      .then((value) => { if (!cancelled) { setConnection(value); setMode(value.defaultMode) } })
      .catch((e) => { if (!cancelled) setError(e.message) })
    return () => { cancelled = true }
  }, [name, cloud, api])

  const plan = connection?.modes[mode] ?? connection?.modes.ssh
  const actionLabel = mode === "ssh" ? "Open SSH in terminal"
    : mode === "attach" ? "Attach canonical TTY"
    : `Exec new ${sessionName(plan?.session)?.toLowerCase() ?? "session"}`
  const unavailable = error || (!connection ? "Checking connection…"
    : !connection.cliInstalled ? "Install the openshell CLI to connect."
    : !connection.sshInstalled ? "Install OpenSSH to connect."
    : !connection.terminalSupported ? "Opening a system terminal is supported on macOS and Linux."
    : null)

  async function openEditor(editor) {
    setOpening(true)
    try {
      await api.openEditor(name, editor.id)
      toast.success(`Opening ${name} in ${editor.label}`)
    } catch (e) { toast.error(e.message) }
    finally { setOpening(false) }
  }

  async function copyCommand() {
    try { await navigator.clipboard.writeText(plan.command); toast.success("SSH command copied") }
    catch { toast.error("Couldn’t copy SSH command") }
  }

  async function open() {
    setOpening(true)
    try {
      await api.openSshTerminal(name, mode)
      toast.success(mode === "ssh" ? `Opening SSH to ${name}` : mode === "attach" ? `Attaching to ${name}` : `Starting a new session in ${name}`)
    } catch (e) {
      toast.error("Couldn’t open SSH terminal", { description: e.message })
    } finally {
      setOpening(false)
    }
  }

  async function showConfig() {
    setLoadingConfig(true)
    try { setConfig(await api.sshConfig(name)) }
    catch (e) { toast.error("Couldn’t generate SSH config", { description: e.message }) }
    finally { setLoadingConfig(false) }
  }

  const browser = <Button variant="outline" size="sm" className="justify-start text-xs" nativeButton={false} disabled={!cloud && (!context?.name || !context?.workspace)} render={<a href={cloud || (context?.name && context?.workspace) ? terminalHref(name, undefined, context) : undefined} target="_blank" rel="noreferrer" />}>
    <Globe className="size-3.5" />Browser
  </Button>

  if (cloud) return <Section title="Open in"><div className="grid grid-cols-2 gap-1.5">{browser}</div></Section>

  return (
    <>
      <Section title="Open in">
        {connection && <>
          <dl aria-label="SSH target" className="mb-3 grid gap-1 text-[11px]">
            <div><dt className="text-muted-foreground">Gateway</dt><dd className="break-all font-mono">{connection.gateway.name}</dd></div>
            <div><dt className="text-muted-foreground">Workspace</dt><dd className="break-all font-mono">{connection.gateway.workspace}</dd></div>
            <div><dt className="text-muted-foreground">Sandbox</dt><dd className="break-all font-mono">{name}</dd></div>
          </dl>
          <div className="mb-2 flex flex-wrap gap-1 rounded-md bg-muted p-1">
            <Button type="button" variant={mode === "ssh" ? "secondary" : "ghost"} size="xs" onClick={() => setMode("ssh")}>SSH shell</Button>
            <Button type="button" variant={mode === "exec" ? "secondary" : "ghost"} size="xs" onClick={() => setMode("exec")}>Exec new</Button>
            {connection.modes.attach && <Button type="button" variant={mode === "attach" ? "secondary" : "ghost"} size="xs" onClick={() => setMode("attach")}>Attach TTY</Button>}
          </div>
        </>}
        <div className="grid grid-cols-2 gap-1.5">
          <Button variant="outline" size="sm" className="justify-start text-xs" disabled={!connection?.canOpenTerminal || opening} title={unavailable ?? actionLabel} onClick={open}>
            {opening ? <Spinner className="size-3.5" /> : <SquareTerminal className="size-3.5" />}Terminal
          </Button>
          {[{ id: "cursor", label: "Cursor" }, { id: "vscode", label: "VS Code" }].map((editor) => {
            const installed = editors.some((item) => item.id === editor.id)
            return <Button key={editor.id} variant="outline" size="sm" className="justify-start text-xs" disabled={!installed || opening} title={!installed ? `${editor.label} is not installed.` : "Connects over SSH through OpenShell. The first time, OpenShell adds one Include line to ~/.ssh/config."} onClick={() => openEditor(editor)}>
              <img src={`/logos/${editor.id}.svg`} alt="" className="size-3.5 dark:invert" />{editor.label}
            </Button>
          })}
          {browser}
        </div>
        {connection && <div className="mt-2 space-y-1.5">
          {plan && <CopyCommand command={plan.command} />}
          <p className="text-[10px] leading-relaxed text-muted-foreground">
            {mode === "ssh" ? "Direct OpenSSH login shell. Its private, temporary config is removed when the session exits."
              : mode === "attach" ? "Reconnects to the sandbox’s original TTY process."
              : "Starts a separate shell or agent with openshell exec."}
          </p>
          <details className="text-[10px] text-muted-foreground">
            <summary className="cursor-pointer py-1">How SSH reaches this sandbox</summary>
            <p className="mt-1">OpenSSH → OpenShell SSH proxy → gateway → this sandbox. The SSH target is the sandbox, not the gateway host.</p>
            <p className="mt-2 break-all font-mono">{connection.gateway.endpoint}</p>
            <p className="mt-1">A localhost gateway address can be a tunnel to a remote Kubernetes cluster. It does not mean the sandbox runs on this machine.</p>
          </details>
        </div>}
        <div className="mt-3 grid gap-1.5 border-t border-border/60 pt-3">
          <Button variant="outline" size="sm" className="justify-start text-xs font-normal text-muted-foreground" disabled={!plan} onClick={copyCommand}>
            <Copy className="size-3.5" />Copy SSH command
          </Button>
          <Button variant="outline" size="sm" className="justify-start text-xs font-normal text-muted-foreground" disabled={!connection?.cliInstalled || loadingConfig} onClick={showConfig}>
            {loadingConfig ? <Spinner className="size-3.5" /> : <SquareCode className="size-3.5" />}SSH configuration
          </Button>
        </div>
        {unavailable && <p role={error ? "alert" : "status"} className="mt-2 text-[11px] text-muted-foreground">{unavailable}</p>}
      </Section>
      <Dialog open={Boolean(config)} onOpenChange={(open) => { if (!open) setConfig(null) }}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>SSH configuration for {name}</DialogTitle>
            <DialogDescription>The console does not change ~/.ssh/config. Review and add this Host block yourself, then connect with the command below.</DialogDescription>
          </DialogHeader>
          {config && <>
            <pre className="max-h-[50svh] overflow-auto whitespace-pre rounded-md border bg-muted/30 p-3 font-mono text-[11px]">{config.config}</pre>
            <CopyCommand command={config.command} />
            <Button variant="outline" onClick={async () => {
              try { await navigator.clipboard.writeText(config.config); toast.success("SSH config copied") }
              catch { toast.error("Couldn’t copy SSH config") }
            }}>Copy Host block</Button>
          </>}
        </DialogContent>
      </Dialog>
    </>
  )
}

const ACCESS_LABEL = { "read-only": "read-only", "read-write": "read-write", full: "full", custom: "custom rules", blocked: "blocked" }
const RULE_TAG = { secret: "from provider", policy: "network rule", org: "blocked everywhere", group: "inherited", agent: "agent defaults", own: "rule" }

export function SandboxSheet(props) {
  const location = useLocation()
  return location && !props.liveData?.demo
    ? <LiveProvider key={location.context}><SandboxSheetContent key={props.name} {...props} scoped /></LiveProvider>
    : <SandboxSheetContent key={props.name} {...props} />
}

function SandboxSheetContent({ name, sandbox: owningSandbox, onClose, onNavigate, onChanged, liveData, scoped }) {
  const api = useApi()
  const location = useLocation()
  const context = useLive()
  const live = scoped ? context : liveData ?? context
  const navigate = (view) => onNavigate(view, location)
  const [minutes, setMinutes] = React.useState(15)
  const [now, setNow] = React.useState(Date.now)
  React.useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(timer) }, [])
  const [detail, setDetail] = React.useState(null)
  const [error, setError] = React.useState(null)
  const [busy, setBusy] = React.useState(null)
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const cloud = useCloudMode()
  const editors = useEditors()
  const summary = live.sandboxes?.find((s) => s.name === name) ?? owningSandbox

  // Re-read the full record whenever the live list reports a change to it:
  // a new phase or policy version means the policy shown here may be stale.
  const version = summary ? `${summary.phase}|${summary.policyVersion}` : null
  React.useEffect(() => {
    if (!name || location?.connected === false) { setDetail(null); setError(location?.error ?? null); return }
    setDetail(null); setError(null)
    if (live.demo) return
    let cancelled = false
    let timer
    let delay = 30000
    const refresh = async () => {
      try { const d = await api.sandbox(name); if (!cancelled) { setDetail(d); setError(null); delay = d.setupJobs?.some(job => job.status === 'waiting') ? 2000 : 30000 } }
      catch (e) { if (!cancelled) setError(e.message) }
      if (!cancelled) timer = setTimeout(refresh, delay)
    }
    refresh()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [name, version, live.demo, api, location?.connected, location?.error])

  const sandbox = detail?.name === name ? detail : summary
  const recent = React.useMemo(() => live.events.filter((e) => e.sandbox === name && e.kind === "audit" && e.verdict).slice(0, 14), [live.events, name])

  async function act(action) {
    if (location?.connected === false) return
    setBusy(action)
    try {
      await api.lifecycle(name, action)
      toast.success(action === "delete" ? `Deleting ${name}` : action === "stop" ? `Stopping ${name}` : `Starting ${name}`)
      onChanged?.()
      live.refresh?.()
      if (action === "delete") onClose()
    } catch (e) {
      toast.error(e.message)
    } finally {
      setBusy(null)
      setConfirmDelete(false)
    }
  }

  const scopedEvents = React.useMemo(() => live.events.filter((e) => e.sandbox === name), [live.events, name])
  const points = React.useMemo(() => bucketEgress(scopedEvents, minutes, now), [scopedEvents, minutes, now])
  const allowed = React.useMemo(() => {
    const hosts = new Map()
    for (const rule of detail?.policy?.rules ?? []) for (const endpoint of rule.endpoints) {
      if (!endpoint.blocked && !hosts.has(endpoint.host)) hosts.set(endpoint.host, { host: endpoint.host, source: sourceOf(rule.key) })
    }
    return [...hosts.values()]
  }, [detail])
  const denied = React.useMemo(() => {
    const hosts = new Map()
    for (const event of scopedEvents) {
      if (event.kind !== "audit" || event.verdict !== "denied") continue
      const host = hostOf(event.destination)
      if (!host) continue
      const item = hosts.get(host) ?? { host, count: 0 }
      item.count += 1
      hosts.set(host, item)
    }
    return [...hosts.values()].sort((a, b) => b.count - a.count)
  }, [scopedEvents])
  const agents = agentsOf(sandbox)
  const phase = sandbox?.phase
  const rules = detail?.policy?.rules ?? []

  return (
    <>
      <Dialog open={Boolean(name)} onOpenChange={(open) => { if (!open) onClose() }}>
        <DialogContent className="flex! h-[min(900px,94svh)] w-[calc(100%-1.5rem)]! max-w-[1280px]! flex-col gap-0! overflow-hidden p-0!">
          <DialogHeader className="shrink-0 border-b border-border px-5 py-4 pr-12">
            <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
            <DialogTitle className="flex min-w-0 items-center gap-2 text-base">
              <Box aria-hidden="true" strokeWidth={1.5} className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{name}</span>
              <LocationBadge location={location} />
              {phase && <span className="ml-2 flex shrink-0 items-center gap-1.5 text-xs font-normal text-muted-foreground"><span className={`size-1.5 rounded-full ${styleOf(phase).cell}`} />{PHASE_LABEL[phase]}</span>}
            </DialogTitle>
                    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-muted-foreground"><span><strong className="mr-1 font-sans font-medium text-foreground">{detail?.policy ? allowed.length : "-"}</strong>allowed hosts</span><span><strong className="mr-1 font-sans font-medium text-foreground">{denied.length}</strong>blocked hosts</span></div>
            </div>
            <DialogDescription className="sr-only">Sandbox access graph, details, rules, files, and connection activity.</DialogDescription>
          </DialogHeader>
          {error && <p role="alert" className="shrink-0 border-b px-5 py-2 text-xs text-destructive">{error}</p>}
          {sandbox ? (
            <Tabs defaultValue="overview" className="min-h-0 flex-1 gap-0!">
              <div className="shrink-0 border-b border-border px-5 py-2">
                <TabsList variant="line" aria-label="Sandbox information" className="max-w-full">
                  <TabsTrigger value="overview" className="px-3 text-xs">Overview</TabsTrigger>
                  <TabsTrigger value="rules" className="px-3 text-xs">Rules{detail?.policy && <span className="text-muted-foreground">{rules.length}</span>}</TabsTrigger>
                  <TabsTrigger value="setups" className="px-3 text-xs">MCPs &amp; Skills</TabsTrigger>
                  <TabsTrigger value="files" className="px-3 text-xs">Files</TabsTrigger>
                  <TabsTrigger value="activity" className="px-3 text-xs">Activity</TabsTrigger>
                  <TabsTrigger value="details" className="px-3 text-xs">Details</TabsTrigger>
                </TabsList>
              </div>
              <TabsContent value="overview" className="min-h-0 overflow-y-auto">
                <div className="grid min-h-full grid-cols-1 lg:h-full lg:grid-cols-[minmax(0,1fr)_250px]">
                  <div className="flex min-w-0 flex-col p-4 sm:p-5">
              <Section title="Access graph" className="flex flex-1 flex-col">
                {detail?.policy ? <Perimeter compact fill agentStatus={agentInventoryLabel(sandbox)} agents={agents} name={name} phase={phase} allowed={allowed} denied={denied}
                  owner={ownerOf(sandbox)} gateway={live.demo ? undefined : live.overview?.gateway}
                  secrets={(sandbox.providers ?? []).map((provider) => live.overview?.providers?.find((item) => item.name === provider) ?? { name: provider })} />
                  : <p className="rounded-lg border border-border p-5 text-sm text-muted-foreground">{live.demo ? "Policy data is unavailable for synthetic sandboxes." : error ? "The access graph is unavailable because the policy could not be loaded." : detail ? "No policy was reported by the gateway." : "Loading access graph…"}</p>}
              </Section>

                  </div>
                  <aside aria-label="Sandbox summary" className="space-y-5 border-t border-border bg-muted/20 p-5 lg:border-t-0 lg:border-l">
                    {phase === "ready" && !live.demo && location?.connected !== false && <OpenIn key={name} name={name} editors={editors} cloud={cloud} context={location ? { name: location.gateway, workspace: location.workspace } : live.overview?.gateway} />}
                    {!live.demo && phase === "ready" && location?.connected !== false && (cloud ? <ContinueLocally key={name} name={name} sandbox={sandbox} /> : <ContinueInCloud key={name} name={name} sandbox={sandbox} />)}
                    <Section title="At a glance">
                      {sandbox.setupJobs?.filter(job => ['waiting', 'failed', 'blocked'].includes(job.status)).map(job => <p key={job.setup} role="status" className="mb-3 text-xs text-muted-foreground">
                        {job.status === 'waiting' ? 'Installing included MCPs and skills…' : `Included tools could not be activated: ${job.error} Open MCPs & Skills to retry.`}
                      </p>)}
                      <dl className="grid grid-cols-2 gap-4 lg:grid-cols-1">
                        {[["Status", <span className="inline-flex items-center gap-1.5"><span className={`size-1.5 rounded-full ${styleOf(phase).cell}`} aria-hidden="true" />{PHASE_LABEL[phase] ?? "Unknown"}</span>], ["Owner", ownerOf(sandbox)], [agents.length === 1 ? "AI agent" : "AI agents", <AgentList agents={agents} status={agentInventoryLabel(sandbox)} />], ["Image", imageName(sandbox.image, sandbox.imageTemplateName)], ["Providers", sandbox.providers.join(", ") || "None"], ["Created", absoluteTime(sandbox.createdAt)], ["Policy", detail ? `v${detail.policyVersionNumber ?? sandbox.policyVersion} · ${detail.policySource ?? "sandbox"}` : "Not reported"]].map(([label, value]) => <div key={label} className="min-w-0"><dt className="text-[11px] text-muted-foreground">{label}</dt><dd className="mt-1 break-words text-xs">{value}</dd></div>)}
                      </dl>
                    </Section>
              {sandbox.problem && statusOf(phase) === "error" && (
                <div className="rounded-md border border-red-200 bg-red-50/60 p-3">
                  <p className="flex items-center gap-1.5 text-xs font-medium text-red-700">
                    <AlertTriangle className="size-3.5" aria-hidden="true" />Failed to start
                  </p>
                  {/* The VM driver reads local images from Docker; with Docker
                      stopped it falls through to Docker Hub, which says "Not authorized". */}
                  {/failed to resolve .*image/i.test(sandbox.problem) && /index\.docker\.io/.test(sandbox.problem) && (
                    <p className="mt-1 text-[11px] text-red-700">Start Docker, then recreate this sandbox.</p>
                  )}
                  <p className="mt-1 max-h-28 overflow-y-auto font-mono text-[10px] leading-relaxed break-words text-red-700/80">{sandbox.problem}</p>
                </div>
              )}

                  </aside>
                </div>
              </TabsContent>
              <TabsContent value="rules" className="min-h-0 space-y-6 overflow-y-auto p-5">
              <Section title="Network rules" icon={Globe}
                aside={<button disabled={location?.connected === false} onClick={() => { try { sessionStorage.setItem("egress-sandbox", name) } catch { /* optional */ } onClose(); navigate("egress") }}
                  className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">Edit</button>}>
                {!detail?.policy ? <p className="text-sm text-muted-foreground">{live.demo ? "Policy data is unavailable in this preview." : error ? "Rules could not be loaded. Close and reopen to retry." : detail ? "No policy reported." : "Loading rules…"}</p>
                  : rules.length === 0 ? <p className="text-[11px] text-muted-foreground">No rules. All outbound denied.</p>
                  : (
                    <ul className="divide-y divide-border/70 rounded-md border border-border">
                      {rules.map((rule) => (
                        <li key={rule.key} className="px-3 py-2">
                          <p className="flex items-center gap-2 text-[11px]">
                            <span className="truncate font-mono font-medium">{sourceOf(rule.key) === "own" ? rule.name : displayName(rule.key)}</span>
                            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{RULE_TAG[sourceOf(rule.key)]}</span>
                          </p>
                          <ul className="mt-1.5 space-y-0.5">
                            {rule.endpoints.map((endpoint) => (
                              <li key={`${endpoint.host}:${endpoint.port}`} className="flex items-center gap-2 font-mono text-[11px]">
                                <span className={`size-1.5 shrink-0 rounded-full ${endpoint.blocked ? "bg-red-500" : "bg-emerald-500"}`} aria-hidden="true" />
                                <span className="min-w-0 flex-1 truncate">{endpoint.host}{endpoint.port ? `:${endpoint.port}` : ""}</span>
                                <span className="shrink-0 text-[10px] text-muted-foreground">{ACCESS_LABEL[endpoint.access] ?? endpoint.access}{endpoint.tlsSkip ? " · TLS passthrough" : ""}{endpoint.protocol !== "tcp" && endpoint.enforcement === "audit" ? " · audit only" : ""}</span>
                              </li>
                            ))}
                          </ul>
                          {rule.binaries.length > 0 && (
                            <p className="mt-1.5 truncate font-mono text-[10px] text-muted-foreground" title={rule.binaries.join(", ")}>
                              {rule.binaries.map((b) => b.split("/").pop()).filter((v, i, a) => a.indexOf(v) === i).join(", ")}
                            </p>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
              </Section>


              </TabsContent>
              <TabsContent value="setups" className="min-h-0 overflow-y-auto">{location?.connected === false ? <p role="status" className="p-5 text-sm text-muted-foreground">Reconnect this location to manage MCPs &amp; Skills.</p> : <SetupsView sandbox={name} setupIds={detail?.setupIds ?? []} />}</TabsContent>
              <TabsContent value="files" className="flex min-h-0 flex-col">
                {location?.connected === false ? <p role="status" className="p-5 text-sm text-muted-foreground">Reconnect this location to access files.</p> : <FilesView sandbox={sandbox} demo={live.demo} />}
              </TabsContent>
              <TabsContent value="activity" className="min-h-0 space-y-6 overflow-y-auto p-5">
              <Section title="Connection activity" aside={<div className="flex gap-1">{[15, 60].map((value) => <button key={value} onClick={() => setMinutes(value)} aria-pressed={minutes === value} className={`rounded px-2 py-1 text-xs ${minutes === value ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-muted"}`}>{value === 15 ? "15m" : "1h"}</button>)}</div>}>
                <div className="rounded-lg border border-border p-4"><EgressChart points={points} height={100} title="Outbound decisions per minute" /></div>
                <p className="mt-2 text-xs text-muted-foreground">Based on the recent event buffer{live.demo ? " · synthetic preview" : ""}.</p>
              </Section>

              <Section title="Egress" aside={recent.length ? <button onClick={() => { onClose(); navigate("activity") }} className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">All</button> : null}>
                {recent.length ? (
                  <div className="rounded-md border border-border">
                    {recent.map((event) => <AuditLine key={`${event.at}|${event.message}`} event={event} dense />)}
                  </div>
                ) : <p className="text-[11px] text-muted-foreground">No connections yet</p>}
              </Section>

              </TabsContent>
              <TabsContent value="details" className="min-h-0 space-y-5 overflow-y-auto p-5">
              <dl className="grid grid-cols-1 gap-5  sm:grid-cols-2">
                {[
                  ["Owner", ownerOf(sandbox)],
                  ["Image", imageName(sandbox.image, sandbox.imageTemplateName), true],
                  ...(sandbox.image && imageName(sandbox.image, sandbox.imageTemplateName) !== sandbox.image ? [["Image reference", sandbox.image, true]] : []),
                  ["Command", commandText(sandbox.command), true],
                  [agents.length === 1 ? "AI agent" : "AI agents", <AgentList agents={agents} status={agentInventoryLabel(sandbox)} />],
                  ["Providers", sandbox.providers.join(", ") || "None"],
                  ["Created", absoluteTime(sandbox.createdAt)],
                  ["Workspace", sandbox.workspace],
                  ["Policy", detail ? `v${detail.policyVersionNumber ?? sandbox.policyVersion} · ${detail.policySource ?? "sandbox"}` : `v${sandbox.policyVersion ?? "-"}`],
                  ["Sandbox ID", sandbox.id, true, true],
                ].map(([label, value, mono, wide]) => (
                  <div key={label} className={wide ? "sm:col-span-2" : undefined}>
                    <dt className="mb-1 text-[11px] text-muted-foreground">{label}</dt>
                    <dd className={`break-all ${mono ? "font-mono text-xs" : "text-sm"}`}>{value ?? "Not reported"}</dd>
                  </div>
                ))}
              </dl>

              </TabsContent>
            </Tabs>
          ) : <p role="status" className="flex-1 p-5 text-sm text-muted-foreground">{error ? "Sandbox details unavailable." : "Loading sandbox…"}</p>}
              {sandbox && !live.demo && <div className="flex shrink-0 flex-wrap gap-2 border-t border-border bg-muted/20 px-5 py-3">
                {canStop(phase) && (
                  <Button variant="outline" size="sm" disabled={Boolean(busy) || location?.connected === false} onClick={() => act("stop")}>
                    {busy === "stop" ? <Spinner aria-hidden="true" /> : <Square aria-hidden="true" />}Stop
                  </Button>
                )}
                {canStart(phase) && (
                  <Button variant="outline" size="sm" disabled={Boolean(busy) || location?.connected === false} onClick={() => act("start")}>
                    {busy === "start" ? <Spinner aria-hidden="true" /> : <Play aria-hidden="true" />}Start
                  </Button>
                )}
                <Button variant="outline" size="sm" disabled={Boolean(busy) || location?.connected === false || phase === "deleting"}
                  className="border-destructive/30 text-destructive hover:bg-destructive/5 hover:text-destructive"
                  onClick={() => setConfirmDelete(true)}>
                  <Trash2 aria-hidden="true" />Delete
                </Button>
              </div>}
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {name}?</AlertDialogTitle>
            <AlertDialogDescription>
              All files inside will be lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => act("delete")} disabled={busy === "delete"}>
              {busy === "delete" && <Spinner aria-hidden="true" />}Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
