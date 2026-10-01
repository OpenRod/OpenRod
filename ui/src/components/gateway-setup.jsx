import * as React from "react"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { SelectField } from "@/components/ui/select-field"
import { api } from "@/lib/api"

export function GatewaySetup({ open, onOpenChange, initialMode = "local" }) {
  const [connections, setConnections] = React.useState(null)
  const [mode, setMode] = React.useState(initialMode)
  const [runtimeInstallation, setRuntimeInstallation] = React.useState("download")
  const [selection, setSelection] = React.useState("")
  const [job, setJob] = React.useState(null)
  const [file, setFile] = React.useState(null)
  const [busy, setBusy] = React.useState(null)
  const [refreshing, setRefreshing] = React.useState(false)
  const [error, setError] = React.useState(null)
  const [pollError, setPollError] = React.useState(null)
  const [revision, setRevision] = React.useState(0)
  const generation = React.useRef(0)
  const choice = React.useRef(null)
  const pendingJob = React.useRef(null)
  const refreshController = React.useRef(null)
  const prefix = React.useId()

  React.useEffect(() => {
    if (!open) {
      choice.current = null
      setConnections(null)
      setRefreshing(false)
      setFile(null)
      setMode(initialMode)
      setRuntimeInstallation("download")
      return
    }
    const controller = new AbortController()
    const id = ++generation.current
    refreshController.current = controller
    const timeout = setTimeout(() => controller.abort(new Error("Reading connections timed out. Your existing choices are unchanged; try refreshing again.")), 10_000)
    setRefreshing(true); setError(null); setPollError(null)
    api.connections(controller.signal).then((next) => {
      if (generation.current !== id) return
      setConnections(next)
      setJob(next.job)
      if (next.job?.status === "ready" && pendingJob.current === next.job.id) {
        window.location.reload()
        return
      }
      if (next.job?.status === "working") pendingJob.current = next.job.id
      if (["working", "needs-docker", "needs-install"].includes(next.job?.status)) {
        setRuntimeInstallation(next.job.runtimeInstallation || (next.job.status === "needs-install" ? "upload" : "download"))
      }
      const remote = initialMode === "ssh"
      const restored = next.job && ["working", "needs-docker", "needs-install"].includes(next.job.status)
        ? { mode: next.job.host ? "ssh" : "local", selection: next.job.host || next.job.gateway || "" }
        : choice.current ?? {
          mode: remote ? "ssh" : "local",
          selection: remote ? (next.active?.host || next.hosts[0]?.name || "") : (next.locals[0]?.name || ""),
        }
      choice.current = restored
      setMode(restored.mode)
      setSelection(restored.selection)
    }).catch((error) => {
      if (generation.current === id && error.name !== "AbortError") setError(error.message)
    }).finally(() => {
      clearTimeout(timeout)
      if (refreshController.current === controller) setRefreshing(false)
    })
    return () => { controller.abort(); clearTimeout(timeout); generation.current += 1 }
  }, [open, revision, initialMode])

  React.useEffect(() => {
    if (!open || job?.status !== "working" || pollError || busy || refreshing) return
    const controller = new AbortController()
    const id = generation.current
    let timer
    async function poll() {
      try {
        const next = await api.connectionJob(job.id, controller.signal)
        if (controller.signal.aborted || generation.current !== id) return
        setJob(next)
        if (next.status === "ready") window.location.reload()
        else if (next.status === "working") timer = setTimeout(poll, 1000)
      } catch (error) {
        if (!controller.signal.aborted && generation.current === id) setPollError(error.message)
      }
    }
    timer = setTimeout(poll, 500)
    return () => { controller.abort(); clearTimeout(timer) }
  }, [open, job?.id, job?.status, pollError, busy, refreshing])

  const locked = Boolean(busy) || job?.status === "working"
  const choices = (mode === "ssh" ? connections?.hosts : connections?.locals) ?? []
  const selected = choices.find((item) => item.name === selection)
  const missingTools = mode === "ssh" && connections && !connections.tools.ssh

  function choose(nextMode, value) {
    generation.current += 1
    refreshController.current?.abort()
    choice.current = { mode: nextMode, selection: value }
    pendingJob.current = null
    setMode(nextMode); setSelection(value); setJob(null); setFile(null); setError(null); setPollError(null)
  }

  async function run(kind, operation) {
    const id = ++generation.current
    refreshController.current?.abort()
    setBusy(kind); setError(null); setPollError(null)
    try {
      const next = await operation()
      if (generation.current !== id) return
      setJob(next)
      if (next.status === "working") pendingJob.current = next.id
      if (next.status === "ready") window.location.reload()
    } catch (error) {
      if (generation.current === id) setError(error.message)
    } finally {
      if (generation.current === id) setBusy(null)
    }
  }

  async function disconnect() {
    const id = ++generation.current
    refreshController.current?.abort()
    setBusy("disconnect"); setError(null)
    try {
      await api.disconnectRemote()
      if (generation.current !== id) return
      window.location.reload()
    } catch (error) {
      if (generation.current === id) setError(error.message)
    } finally {
      if (generation.current === id) setBusy(null)
    }
  }

  return <Dialog open={open} onOpenChange={(value) => { if (!busy) onOpenChange(value) }}>
    <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>Connect sandbox location</DialogTitle>
        <DialogDescription>Use a local gateway or run sandboxes on an SSH host. A persistent gateway is prepared on the remote machine so work can continue while your computer sleeps.</DialogDescription>
      </DialogHeader>
      <div className="grid gap-4 text-xs">
        <div className="grid gap-1.5">
          <Label htmlFor={`${prefix}-mode`}>Sandbox location</Label>
          <SelectField id={`${prefix}-mode`} value={mode} disabled={locked || !connections} onChange={(event) => {
            const next = event.target.value
            choose(next, (next === "ssh" ? connections.hosts : connections.locals)[0]?.name || "")
          }}>
            <option value="local">Local registered gateway</option>
            <option value="ssh">Remote Docker host over SSH</option>
          </SelectField>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${prefix}-selection`}>{mode === "ssh" ? "SSH Host alias" : "Local gateway"}</Label>
          <SelectField id={`${prefix}-selection`} value={selected ? selection : ""} disabled={locked || !choices.length} onChange={(event) => choose(mode, event.target.value)}>
            <option value="" disabled>{mode === "ssh" ? "Choose an SSH alias" : "Choose a local gateway"}</option>
            {choices.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
          </SelectField>
          {mode === "local" && selected?.endpoint && <p className="break-all font-mono text-muted-foreground">{selected.endpoint}</p>}
          {connections && !choices.length && <p role="status" className="text-muted-foreground">{mode === "ssh" ? <>No concrete SSH aliases found. Add a <code>Host my-host</code> entry with HostName, User and IdentityFile to <code>~/.ssh/config</code> on this computer, then refresh. Wildcard Host entries are not connection choices.</> : "No local gateways are registered. Start your local OpenShell gateway outside this dialog, then refresh, or choose an SSH host."}</p>}
        </div>
        {mode === "ssh" && <div className="grid gap-1.5">
          <Label htmlFor={`${prefix}-installation`}>Missing OpenShell runtime</Label>
          <SelectField id={`${prefix}-installation`} value={runtimeInstallation} disabled={locked || job?.status === "needs-install" || job?.status === "needs-docker"} onChange={(event) => setRuntimeInstallation(event.target.value)}>
            <option value="download">Download automatically</option>
            <option value="upload">Upload package</option>
          </SelectField>
          <p className="text-muted-foreground">The host is checked first. Existing runtime images are reused; missing images are downloaded automatically or installed from your package before connecting.</p>
        </div>}
        {mode === "ssh" && <div className="grid gap-2 text-muted-foreground">
          <p>Requires a reachable Linux host and trusted key-based SSH access. Working Docker is reused; existing Docker must be accessible to the SSH user without an interactive password or sudo prompt. If Docker is missing on a supported Ubuntu or Debian host, you will be asked before it is installed. Other distributions require manual Docker setup.</p>
          <p>Run <code>ssh {selection || "my-host"}</code> once in your terminal to verify the host key and key-based login. SSH errors below are not retried automatically.</p>
          <p>Connect only to a trusted host. Docker access gives host-administrator authority; the remote supervisor receives credentials for the separate remote-work gateway, never your original gateway.</p>
          <p>The remote gateway uses the pinned OpenShell Docker image and stays running after disconnect. Python 3 is required on the SSH host. Your existing local gateway keeps its own settings.</p>
          {missingTools && <p role="alert" className="text-destructive">OpenSSH (ssh) is missing on this computer. Install it, then refresh.</p>}
        </div>}
        <Button type="button" variant="outline" size="sm" className="justify-self-start" disabled={Boolean(busy) || refreshing} onClick={() => setRevision((value) => value + 1)}>{refreshing ? "Reading connections…" : "Refresh hosts and status"}</Button>
        {job && <div role="status" aria-live="polite" className="grid gap-2 rounded-md border p-3">
          <p className="font-medium">{job.host || job.gateway || "Local gateway"}: {job.status === "needs-docker" ? "Docker installation approval required" : job.status === "needs-install" ? "Runtime images required" : job.status === "working" ? "Connecting…" : job.status === "ready" ? "Connected" : "Connection failed"}</p>
          <p className="whitespace-pre-wrap break-words">{job.stage}</p>
          {job.probe && <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-muted-foreground">
            <dt>Host</dt><dd>{job.probe.os || "Unknown OS"} / {job.probe.arch || "Unknown architecture"}</dd>
            <dt>Docker socket</dt><dd className="break-all">{job.probe.dockerSocket || "Not detected"}</dd>
            <dt>Runtime</dt><dd>{job.probe.version || "Pinned OpenShell version"} — {job.probe.runtimeReady ? "images ready" : "images missing"}</dd>
          </dl>}
        </div>}
        {job?.status === "needs-docker" && <div className="grid gap-3 rounded-md border p-3">
          <p>Docker is missing on <strong>{job.host}</strong>. Nothing will be installed unless you approve below. Close to decline without making changes.</p>
          {job.probe?.dockerInstallSupported ? <>
            <p>Installing requires SSH access as root or passwordless sudo. On supported Ubuntu and Debian hosts, this updates apt package lists and installs the distribution’s <code>docker.io</code> package and its dependencies, enables and starts the Docker system service, and adds the SSH user to the <code>docker</code> group.</p>
            <p className="font-medium">Membership in the docker group grants root-equivalent control of this host.</p>
            <p className="text-muted-foreground">Docker access is verified using a fresh SSH connection. Existing Docker is not replaced or repaired automatically. If installation fails partway through, packages, service changes, or group membership may remain.</p>
            <p className="text-muted-foreground">{runtimeInstallation === "upload" ? "After Docker is ready, you will be asked to upload the missing OpenShell runtime images." : "After Docker is ready, missing OpenShell runtime images will be downloaded automatically and the connection will continue."}</p>
            <Button type="button" disabled={locked || refreshing} onClick={() => run("docker", () => api.installConnectionDocker(job.id))}>{busy === "docker" ? "Starting Docker installation…" : "Install Docker and continue"}</Button>
          </> : <>
            <p className="text-muted-foreground">{job.probe?.dockerInstallReason || "Automatic Docker installation is available only on supported Ubuntu and Debian hosts with systemd."} Install and start Docker manually and ensure the SSH user has Docker access, then check the host again.</p>
            <Button type="button" variant="outline" disabled={locked || refreshing} onClick={() => run("check-docker", () => api.connect({ host: job.host, runtimeInstallation }))}>Check manual Docker setup</Button>
          </>}
        </div>}
        {job?.status === "needs-install" && <div className="grid gap-3 rounded-md border p-3">
          <p>Install the pinned OpenShell runtime images on <strong>{job.host}</strong>. The persistent gateway image is also required; include gateway:0.1.2 in offline packages.</p>
          <Button type="button" variant="outline" disabled={locked} onClick={() => run("download", () => api.installConnectionRuntime(job.id))}>{busy === "download" ? "Starting download…" : "Download on remote"}</Button>
          <p className="text-muted-foreground">Or upload a trusted <code>docker save</code> .tar archive containing the required runtime images for this host’s architecture and pinned version. The archive is streamed to the remote Docker engine.</p>
          <Label htmlFor={`${prefix}-package`}>Docker-save package (.tar)</Label>
          <Input id={`${prefix}-package`} type="file" accept=".tar,application/x-tar" disabled={locked} onChange={(event) => {
            const next = event.target.files?.[0] ?? null
            setFile(next); setError(null)
          }} />
          {file && !file.name.toLowerCase().endsWith(".tar") && <p role="alert" className="text-destructive">Choose an uncompressed .tar Docker-save archive.</p>}
          <Button type="button" variant="outline" disabled={locked || !file?.name.toLowerCase().endsWith(".tar")} onClick={() => run("upload", () => api.uploadConnectionPackage(job.id, file))}>{busy === "upload" ? "Uploading package…" : "Upload package"}</Button>
        </div>}
        {(error || job?.error) && <p role="alert" className="whitespace-pre-wrap break-words text-destructive">{error || job.error}</p>}
        {pollError && <p role="alert" className="break-words text-destructive">Could not read connection progress: {pollError}. The operation may still be running. Refresh status to resume monitoring; this does not retry the connection.</p>}
        {connections?.active && <div className="grid gap-2 rounded-md border p-3">
          <p>Remote connection: <strong>{connections.active.host}</strong> — {connections.active.status}</p>
          {connections.active.error && <p role="alert" className="whitespace-pre-wrap break-words text-destructive">{connections.active.error}</p>}
          <Button type="button" variant="outline" size="sm" disabled={locked} onClick={disconnect}>Disconnect from remote</Button>
          <p className="text-muted-foreground">Closes your SSH tunnels. The remote gateway and persistent agent sessions keep running.</p>
        </div>}
        <p className="text-muted-foreground">Closing the console or putting your computer to sleep disconnects your viewer. Remote work keeps running. Reconnect to the same host to reattach.</p>
      </div>
      <DialogFooter>
        <Button type="button" variant="ghost" disabled={Boolean(busy)} onClick={() => onOpenChange(false)}>Close</Button>
        <Button type="button" disabled={locked || !selected || missingTools || job?.status === "needs-install" || job?.status === "needs-docker"} onClick={() => run("connect", () => api.connect(mode === "ssh" ? { host: selection, runtimeInstallation } : { localGateway: selection }))}>{busy === "connect" ? "Connecting…" : job?.status === "failed" ? "Try connection again" : "Connect"}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
