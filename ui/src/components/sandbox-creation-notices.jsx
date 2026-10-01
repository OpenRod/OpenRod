import * as React from "react"
import { ArrowUpRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { LocationBadge } from "@/components/location-badge"
import { Notice } from "@/components/notice"
import { useInventory } from "@/lib/inventory"
import { sandboxCreations } from "@/lib/sandbox-creations"
import { PHASE_LABEL } from "@/lib/sandboxes"

export const BOX_HANDOFF = "gateway-box"
const ENDED = ["error", "stopped", "completed", "deleting"]
const keyOf = (location, name) => JSON.stringify([location?.context, name])
const waiting = (job) => job.status === "created" && job.phase !== "ready" && !ENDED.includes(job.phase)

// Follows created sandboxes until they are ready, wherever the user is.
function CreationWatcher({ jobs }) {
  const { sandboxes, loading } = useInventory()
  React.useEffect(() => {
    if (loading) return
    const reported = new Map(sandboxes.map((sandbox) => [keyOf(sandbox.location, sandbox.name), sandbox]))
    for (const job of jobs) {
      const sandbox = reported.get(keyOf(job.location, job.name))
      if (sandbox) { if (sandbox.phase !== job.phase || !job.reported) sandboxCreations.update(job.id, { phase: sandbox.phase, reported: true, sandbox }) }
      else if (job.reported) sandboxCreations.dismiss(job.id)
    }
  }, [sandboxes, loading, jobs])
  return null
}

function openSandbox(job) {
  try { sessionStorage.setItem(BOX_HANDOFF, JSON.stringify({ name: job.name, location: job.location })) } catch { /* optional */ }
  window.dispatchEvent(new CustomEvent("openrod-navigate", { detail: { view: "sandboxes" } }))
  // The Sandboxes page may already be open; it then takes the handoff from this event.
  window.dispatchEvent(new Event(BOX_HANDOFF))
}

function BuildLogs({ job, onClose }) {
  const logs = React.useRef(null)
  const follow = React.useRef(true)
  const build = job.build
  React.useEffect(() => { if (follow.current && logs.current) logs.current.scrollTop = logs.current.scrollHeight }, [build?.logs, job.message])
  return <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
    <DialogContent className="flex h-[min(36rem,90svh)] flex-col gap-3 sm:max-w-2xl">
      <DialogHeader><DialogTitle>Build logs · {job.name}</DialogTitle><DialogDescription>{build?.status === "failed" ? "Build failed" : job.status === "failed" ? "Creation failed" : job.status === "cancelled" ? "Creation cancelled" : build?.status === "ready" ? "Build complete" : job.message || "Preparing environment…"}</DialogDescription></DialogHeader>
      {build?.name && <p className="truncate font-mono text-[11px] text-muted-foreground">{build.name}</p>}
      <pre ref={logs} tabIndex={0} aria-label="Build output" onScroll={(event) => { const el = event.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40 }} className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all rounded-md border bg-muted/30 p-3 font-mono text-[10px] leading-relaxed">{build?.logs || (build?.status === "ready" ? "Using a ready image template. No build was needed." : "Waiting for build output…")}</pre>
      {(build?.error || job.error) && <p role="alert" className="text-xs text-destructive">{build?.error || job.error}</p>}
    </DialogContent>
  </Dialog>
}

export function SandboxCreationNotifications() {
  const jobs = React.useSyncExternalStore(sandboxCreations.subscribe, sandboxCreations.getSnapshot)
  const [logsFor, setLogsFor] = React.useState(null)
  const watched = jobs.filter((job) => job.status === "created")
  const logsJob = jobs.find((job) => job.id === logsFor)
  return <>
    {watched.some(waiting) && <CreationWatcher jobs={watched} />}
    {jobs.map((job) => {
      const ready = job.status === "created" && job.phase === "ready"
      const ended = job.status === "created" && ENDED.includes(job.phase)
      const working = job.status === "preparing" || job.status === "creating" || waiting(job)
      const showBuild = job.build && <Button size="xs" variant="outline" onClick={() => setLogsFor(job.id)}>Show build</Button>
      const props = job.status === "preparing" ? { tone: "progress", title: `Preparing ${job.name}…`, body: job.message, actions: <>{showBuild}<Button size="xs" variant="ghost" onClick={() => sandboxCreations.cancel(job.id)}>Cancel</Button></> }
        : job.status === "creating" ? { tone: "progress", title: `Creating ${job.name}…`, body: job.message }
        : job.status === "failed" ? { tone: "error", title: `Couldn’t create ${job.name}`, body: job.error, actions: <>{showBuild}<Button size="xs" variant="outline" onClick={() => sandboxCreations.retry(job.id)}>Try again</Button></> }
        : job.status === "cancelled" ? { tone: "info", title: `${job.name} not created`, body: "Creation was cancelled." }
        : ready ? { tone: "success", title: `${job.name} is ready`, body: "Your sandbox is ready to use.", actions: <Button size="xs" variant="outline" disabled={job.location?.connected === false} onClick={() => openSandbox(job)}>Open sandbox<ArrowUpRight className="size-3" /></Button> }
        : ended ? { tone: "error", title: `${job.name} needs attention`, body: `Status: ${PHASE_LABEL[job.phase]}. Open the sandbox to inspect it.`, actions: <Button size="xs" variant="outline" onClick={() => openSandbox(job)}>Open sandbox<ArrowUpRight className="size-3" /></Button> }
        : { tone: "progress", title: `Starting ${job.name}…`, body: "Your new sandbox is starting. You can keep browsing while it gets ready." }
      return <Notice key={job.id} id={`sandbox-creation:${job.id}`} tone={props.tone} title={props.title}
        actions={<><LocationBadge location={job.location} />{props.actions}</>}
        onDismiss={working ? undefined : () => sandboxCreations.dismiss(job.id)} dismissLabel={`Dismiss status for ${job.name}`}>
        {props.body}
      </Notice>
    })}
    {logsJob && <BuildLogs job={logsJob} onClose={() => setLogsFor(null)} />}
  </>
}
