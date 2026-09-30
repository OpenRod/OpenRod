import * as React from "react"
import { AlertTriangle, Box, FolderLock, Globe, Play, Square, SquareCode, SquareTerminal, Terminal, Trash2 } from "lucide-react"
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
import { FilesView } from "@/components/files-view"
import { api } from "@/lib/api"
import { useLive } from "@/lib/live"
import { SESSION_LABEL, sessionCommand, terminalHref } from "@/lib/sandbox-session"
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

// Installed editors don't change while the console is open, so ask once, and
// keep retrying while the sheet is open if that first request fails.
let editorsRequest
function useEditors() {
  const [editors, setEditors] = React.useState([])
  React.useEffect(() => {
    let cancelled = false
    let timer
    const load = () => {
      editorsRequest ??= api.editors().then((list) => list.filter((editor) => editor.installed))
      editorsRequest.then((list) => { if (!cancelled) setEditors(list) })
        .catch(() => { editorsRequest = undefined; if (!cancelled) timer = setTimeout(load, 3000) })
    }
    load()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [])
  return editors
}

// Same as `openshell sandbox connect --editor`: OpenShell adds its SSH config
// and the editor connects over Remote-SSH, so files open in place.
function OpenInEditor({ name, editors }) {
  const [opening, setOpening] = React.useState(null)
  async function open(editor) {
    setOpening(editor.id)
    try {
      await api.openEditor(name, editor.id)
      toast.success(`Opening ${name} in ${editor.label}`)
    } catch (e) {
      toast.error(e.message)
    } finally {
      setOpening(null)
    }
  }
  return (
    <div className="flex flex-col gap-1.5">
      {editors.map((editor) => (
        <Button key={editor.id} variant="outline" size="sm" className="w-full justify-start text-xs" disabled={Boolean(opening)}
          title="Connects over SSH through OpenShell. The first time, OpenShell adds one Include line to ~/.ssh/config."
          onClick={() => open(editor)}>
          {opening === editor.id ? <Spinner className="size-3.5" />
            : editor.id === "cursor" ? <img src="/logos/cursor.svg" alt="" aria-hidden="true" className="size-3.5 dark:invert" draggable={false} />
            : <SquareCode className="size-3.5" aria-hidden="true" />}
          Open in {editor.label}
        </Button>
      ))}
    </div>
  )
}

// The session opens in a new browser tab, so this stays a plain link.
function OpenWebTerminal({ name }) {
  return (
    <Button variant="outline" size="sm" className="w-full justify-start text-xs" nativeButton={false}
      render={<a href={terminalHref(name)} target="_blank" rel="noreferrer" />}>
      <Terminal className="size-3.5" aria-hidden="true" />Open in browser
    </Button>
  )
}

function OpenInTerminal({ name, disabled }) {
  const [opening, setOpening] = React.useState(false)
  return (
    <Button variant="outline" size="sm" className="w-full justify-start text-xs" disabled={disabled || opening}
      onClick={async () => {
        setOpening(true)
        try { await api.openTerminal(name) } catch (e) { toast.error("Couldn’t open terminal", { description: e.message }) } finally { setOpening(false) }
      }}>
      {opening ? <Spinner className="size-3.5" /> : <SquareTerminal className="size-3.5" aria-hidden="true" />}Open in terminal
    </Button>
  )
}

const ACCESS_LABEL = { "read-only": "read-only", "read-write": "read-write", full: "full", custom: "custom rules", blocked: "blocked" }
const RULE_TAG = { secret: "from provider", policy: "policy", org: "blocked everywhere", group: "inherited", agent: "agent defaults", own: "rule" }

export function SandboxSheet({ name, onClose, onNavigate, liveData }) {
  const context = useLive()
  const live = liveData ?? context
  const [minutes, setMinutes] = React.useState(15)
  const [now, setNow] = React.useState(Date.now)
  React.useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(timer) }, [])
  const [detail, setDetail] = React.useState(null)
  const [error, setError] = React.useState(null)
  const [busy, setBusy] = React.useState(null)
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const editors = useEditors()
  const summary = live.sandboxes?.find((s) => s.name === name)

  // Re-read the full record whenever the live list reports a change to it:
  // a new phase or policy version means the policy shown here may be stale.
  const version = summary ? `${summary.phase}|${summary.policyVersion}` : null
  React.useEffect(() => {
    if (!name) { setDetail(null); setError(null); return }
    setDetail(null); setError(null)
    if (live.demo) return
    let cancelled = false
    let timer
    const refresh = async () => {
      try { const d = await api.sandbox(name); if (!cancelled) { setDetail(d); setError(null) } }
      catch (e) { if (!cancelled) setError(e.message) }
      if (!cancelled) timer = setTimeout(refresh, 30000)
    }
    refresh()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [name, version, live.demo])

  const sandbox = detail?.name === name ? detail : summary
  const recent = React.useMemo(() => live.events.filter((e) => e.sandbox === name && e.kind === "audit" && e.verdict).slice(0, 14), [live.events, name])

  async function act(action) {
    setBusy(action)
    try {
      await api.lifecycle(name, action)
      toast.success(action === "delete" ? `Deleting ${name}` : action === "stop" ? `Stopping ${name}` : `Starting ${name}`)
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
  const attachable = Boolean(sandbox?.tty || sandbox?.labels?.[SESSION_LABEL])
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
                    {phase === "ready" && (attachable || (editors.length > 0 && !live.demo)) && (
                      <Section title="Attach">
                        <div className="space-y-2">
                          {!live.demo && <OpenInEditor name={name} editors={editors} />}
                          {attachable && !live.demo && <OpenWebTerminal name={name} />}
                          {attachable && !live.demo && <OpenInTerminal name={name} />}
                          {attachable && <CopyCommand command={sessionCommand(sandbox)} />}
                        </div>
                      </Section>
                    )}
                    <Section title="At a glance">
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
                aside={<button onClick={() => { try { sessionStorage.setItem("egress-sandbox", name) } catch { /* optional */ } onClose(); onNavigate("egress") }}
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

              {detail?.policy && (
                <Section title="Files" icon={FolderLock}>
                  <div className="space-y-2 text-[11px]">
                    <p>
                      <span className="text-muted-foreground">Read-write · </span>
                      <span className="font-mono">{[detail.policy.filesystem.workdir ? "/sandbox" : null, ...detail.policy.filesystem.readWrite].filter(Boolean).join("  ")}</span>
                    </p>
                    <p>
                      <span className="text-muted-foreground">Read-only · </span>
                      <span className="font-mono">{detail.policy.filesystem.readOnly.join("  ")}</span>
                    </p>
                  </div>
                </Section>
              )}

              </TabsContent>
              <TabsContent value="files" className="flex min-h-0 flex-col">
                <FilesView sandbox={sandbox} demo={live.demo} />
              </TabsContent>
              <TabsContent value="activity" className="min-h-0 space-y-6 overflow-y-auto p-5">
              <Section title="Connection activity" aside={<div className="flex gap-1">{[15, 60].map((value) => <button key={value} onClick={() => setMinutes(value)} aria-pressed={minutes === value} className={`rounded px-2 py-1 text-xs ${minutes === value ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-muted"}`}>{value === 15 ? "15m" : "1h"}</button>)}</div>}>
                <div className="rounded-lg border border-border p-4"><EgressChart points={points} height={100} title="Outbound decisions per minute" /></div>
                <p className="mt-2 text-xs text-muted-foreground">Based on the recent event buffer{live.demo ? " · synthetic preview" : ""}.</p>
              </Section>

              <Section title="Egress" aside={recent.length ? <button onClick={() => { onClose(); onNavigate("activity") }} className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">All</button> : null}>
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
                  <Button variant="outline" size="sm" disabled={Boolean(busy)} onClick={() => act("stop")}>
                    {busy === "stop" ? <Spinner aria-hidden="true" /> : <Square aria-hidden="true" />}Stop
                  </Button>
                )}
                {canStart(phase) && (
                  <Button variant="outline" size="sm" disabled={Boolean(busy)} onClick={() => act("start")}>
                    {busy === "start" ? <Spinner aria-hidden="true" /> : <Play aria-hidden="true" />}Start
                  </Button>
                )}
                <Button variant="outline" size="sm" disabled={Boolean(busy) || phase === "deleting"}
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
