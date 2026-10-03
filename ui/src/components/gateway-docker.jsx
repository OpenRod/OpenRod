import * as React from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { CopyCommand } from "@/components/copy-command"
import { Notice } from "@/components/notice"
import { gatewayDocker } from "@/lib/gateway-docker-store"

const DISMISSED = "openrod.gateway-docker.dismissed"
const SHOWN = "openrod.gateway-docker.shown"
const FAILED = "openrod.gateway-docker.failed"
const read = (key) => { try { return localStorage.getItem(key) } catch { return null } }
const write = (key, value) => { try { localStorage.setItem(key, value) } catch { /* optional */ } }
const dismissKey = (s) => `${s.build?.engineId ?? ""}|${s.conflict?.dockerHost ?? ""}`
const useGatewayDocker = () => React.useSyncExternalStore(gatewayDocker.subscribe, gatewayDocker.getSnapshot)
const keyOf = (sandbox) => `${sandbox.workspace}/${sandbox.name}`

function SandboxList({ label, sandboxes, className = "" }) {
  return <ul aria-label={label} className={`max-h-48 overflow-auto rounded-md border border-border p-3 text-xs ${className}`}>
    {sandboxes.map((sandbox) => <li key={keyOf(sandbox)} className="break-all py-1">{sandbox.name}<span className="text-muted-foreground"> · {sandbox.workspace}</span></li>)}
  </ul>
}

function ConfirmDialog({ status: s, asking, error }) {
  const undo = asking.kind === "undo"
  const { sandboxes, busy } = asking
  const conflict = !undo && s?.conflict
  const stranded = undo ? [] : s?.stranded ?? []
  const file = s?.steps?.file ? <span className="font-mono">{s.steps.file}</span> : "OpenShell’s settings"
  return <AlertDialog open onOpenChange={(open) => { if (!open && !busy) gatewayDocker.close() }}>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>{undo ? "Undo the Docker change?" : "Connect OpenShell to Docker?"}</AlertDialogTitle>
        <AlertDialogDescription>
          {conflict && <span className="mb-2 block break-all font-mono text-[11px]">OpenShell is set to use Docker at {conflict.dockerHost}. OpenRod adds its own line after it.</span>}
          {undo ? <>OpenRod removes its line from {file} and restarts OpenShell. Sandboxes from templates won’t start after that.</>
            : <>OpenRod will set DOCKER_HOST in {file} and restart OpenShell.</>}
        </AlertDialogDescription>
      </AlertDialogHeader>
      {sandboxes == null && <p className="text-xs text-muted-foreground">Running sandboxes restart too. Files in /sandbox are kept; open sessions end.</p>}
      {sandboxes?.length > 0 && <>
        <p className="text-xs text-muted-foreground">These sandboxes restart. Files in /sandbox are kept; open sessions end.</p>
        <SandboxList label="Sandboxes that restart" sandboxes={sandboxes} />
      </>}
      {stranded.length > 0 && <>
        <p className="text-xs text-destructive">These won’t start again: their images aren’t in this Docker.</p>
        <SandboxList label="Sandboxes that won’t start again" sandboxes={stranded} className="text-destructive" />
      </>}
      {!undo && s?.alternative && <p className="text-xs text-muted-foreground">To skip the restart, turn on “Allow the default Docker socket to be used” in Docker Desktop → Settings → Advanced.</p>}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <AlertDialogFooter>
        <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
        <AlertDialogAction variant={stranded.length ? "destructive" : "default"} disabled={busy} onClick={() => undo ? gatewayDocker.undo() : gatewayDocker.connect()}>
          {busy ? "Restarting…" : undo ? "Undo and restart" : conflict ? "Switch and restart" : "Restart OpenShell"}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
}

function StepsDialog({ status: s, asking }) {
  const [checking, setChecking] = React.useState(false)
  const [still, setStill] = React.useState(false)
  const steps = s?.steps
  async function check() {
    setChecking(true)
    const next = await gatewayDocker.refresh(true)
    setChecking(false)
    if (next?.state !== "ok") return setStill(true)
    toast.success("OpenShell can see Docker now")
    gatewayDocker.close()
    asking.then?.()
  }
  return <Dialog open onOpenChange={(open) => { if (!open) gatewayDocker.close() }}>
    <DialogContent className="sm:max-w-xl">
      <DialogHeader>
        <DialogTitle>Connect OpenShell to Docker</DialogTitle>
        <DialogDescription>{[s?.blocked !== "Add one setting to OpenShell and restart it." && s?.blocked, steps && "Add this line to OpenShell’s settings, then restart it. Running sandboxes restart too."].filter(Boolean).join(" ")}</DialogDescription>
      </DialogHeader>
      {steps && <>
        <p className="break-all font-mono text-[11px]">{steps.file}</p>
        <CopyCommand command={steps.append} label={steps.line} />
        {steps.restart ? <CopyCommand command={steps.restart} /> : <p className="text-xs text-muted-foreground">Then restart the OpenShell gateway the way you started it.</p>}
      </>}
      {s?.alternative && <p className="text-xs text-muted-foreground">No restart: in Docker Desktop, open Settings → Advanced and turn on “Allow the default Docker socket to be used”.</p>}
      {still && !checking && <p role="status" className="text-xs text-muted-foreground">OpenShell still can’t see your Docker images.</p>}
      <Button variant="outline" disabled={checking} onClick={check}>{checking ? "Checking…" : "Check again"}</Button>
    </DialogContent>
  </Dialog>
}

// App-level notices for the local gateway's Docker connection, plus the
// dialogs that `gatewayDocker.ask()` opens from anywhere in the console.
export function GatewayDockerNotifications() {
  const { status: s, asking, error } = useGatewayDocker()
  const [dismissed, setDismissed] = React.useState(() => read(DISMISSED))
  const [failedSeen, setFailedSeen] = React.useState(() => read(FAILED))
  const [shown, setShown] = React.useState(null)
  const watching = React.useRef(null)
  const change = s?.lastChange
  const job = s?.job

  // Each change is announced once, while the page is visible, and only soon after it happened.
  React.useEffect(() => {
    if (!change) return
    const announce = () => {
      if (document.visibilityState !== "visible" || read(SHOWN) === change.id || Date.now() - Date.parse(change.at) > 3_600_000) return
      document.removeEventListener("visibilitychange", announce)
      write(SHOWN, change.id)
      if (change.kind === "connect") return setShown(change.id)
      toast.success("Undid the Docker change")
      // The user just chose this; don't ask them to connect again right away.
      if (s.build) { write(DISMISSED, dismissKey(s)); setDismissed(dismissKey(s)) }
    }
    announce()
    document.addEventListener("visibilitychange", announce)
    return () => document.removeEventListener("visibilitychange", announce)
  }, [change?.id])
  // The 15 s only counts while someone can see the page.
  React.useEffect(() => {
    if (!shown) return
    let timer
    const arm = () => { clearTimeout(timer); if (document.visibilityState === "visible") timer = setTimeout(() => setShown(null), 15_000) }
    arm()
    document.addEventListener("visibilitychange", arm)
    return () => { clearTimeout(timer); document.removeEventListener("visibilitychange", arm) }
  }, [shown])
  // A failed undo leaves no notice behind, so report it here.
  React.useEffect(() => {
    if (job?.status === "working") watching.current = job.id
    else if (job && watching.current === job.id) {
      watching.current = null
      if (job.kind === "undo" && job.status === "failed") toast.error("Couldn’t undo the Docker change", { description: job.error })
    }
  }, [job?.id, job?.status])

  const dismiss = () => { write(DISMISSED, dismissKey(s)); setDismissed(dismissKey(s)) }
  const hidden = Boolean(s?.build) && dismissed === dismissKey(s)
  const title = job?.kind === "undo" ? "Undoing the Docker change…" : "Connecting OpenShell to Docker…"
  // A failed connect can leave OpenShell down (unknown), so don't wait for a mismatch to report it.
  const notice = s?.state === "working" && job ? { tone: "progress", title, body: job.stage !== title && job.stage }
    : ["mismatch", "unknown", "no-docker"].includes(s?.state) && job?.kind === "connect" && job.status === "failed" && failedSeen !== job.id ? {
      tone: "error", title: "Couldn’t connect OpenShell to Docker", body: job.error,
      onDismiss: () => { dismiss(); write(FAILED, job.id); setFailedSeen(job.id) },
      actions: <>
        {s.state === "mismatch" && s.fix !== "manual" && <Button size="xs" variant="outline" onClick={() => gatewayDocker.ask({ kind: "connect" })}>Try again</Button>}
        {s.steps && <Button size="xs" variant="outline" onClick={() => gatewayDocker.ask({ kind: "steps" })}>Show steps</Button>}
      </> }
    : shown && change?.id === shown ? {
      tone: "success", title: "Connected OpenShell to Docker", onDismiss: () => setShown(null),
      body: change.auto ? "OpenShell restarted so new sandboxes can use your Docker images." : "New sandboxes can use your Docker images.",
      actions: change.undoable && <Button size="xs" variant="outline" onClick={() => gatewayDocker.ask({ kind: "undo" })}>Undo</Button> }
    : s?.state === "mismatch" && s.fix !== "auto" && !hidden ? {
      tone: "warning", title: "OpenShell can’t see your Docker images",
      body: s.fix === "manual" ? "Add one setting to OpenShell and restart it." : "Sandboxes from templates won’t start until it can.",
      actions: <>
        <Button size="xs" variant="outline" onClick={() => gatewayDocker.ask()}>{s.fix === "manual" ? "Show steps" : "Connect"}</Button>
        <Button size="xs" variant="ghost" onClick={dismiss}>Not now</Button>
      </> }
    : null
  return <>
    {notice && <Notice id="gateway-docker" tone={notice.tone} title={notice.title} actions={notice.actions || undefined} onDismiss={notice.onDismiss}>{notice.body}</Notice>}
    {asking && (asking.kind === "steps" ? <StepsDialog status={s} asking={asking} /> : <ConfirmDialog status={s} asking={asking} error={error} />)}
  </>
}

const hint = "mt-1 text-[11px] text-red-700"

function LocalDockerHint() {
  const { status: s } = useGatewayDocker()
  if (s?.state === "mismatch") return <div className={`${hint} flex flex-wrap items-center gap-2`}>
    OpenShell can’t see your Docker images.
    <Button size="xs" variant="outline" onClick={() => gatewayDocker.ask()}>{s.fix === "manual" ? "Show steps" : "Connect"}</Button>
  </div>
  return <p className={hint}>{s?.state === "working" ? "Connecting OpenShell to Docker…"
    : s?.state === "ok" ? "OpenShell can see Docker now. Delete this sandbox and create it again."
    : "Start Docker, then delete this sandbox and create it again."}</p>
}

// Shown under "Failed to start" when the driver couldn't find a local image.
export function DockerHint({ local }) {
  return local ? <LocalDockerHint /> : <p className={hint}>Start Docker, then delete this sandbox and create it again.</p>
}
