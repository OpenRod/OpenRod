import * as React from "react"
import { ChevronDown, CircleAlert, CircleX, Info, Laptop, Loader2, RefreshCw, Server } from "lucide-react"

import { AnimatedBeam } from "@/components/ui/animated-beam"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { SelectField } from "@/components/ui/select-field"
import { api } from "@/lib/api"

const PENDING = ["working", "needs-docker", "needs-install"]

const STATUS = {
  working: { icon: Loader2, tone: "text-muted-foreground animate-spin motion-reduce:animate-none", title: (job) => `Connecting to ${job.host}` },
  "needs-docker": { icon: CircleAlert, tone: "text-amber-500", title: (job) => `Docker isn’t installed on ${job.host}` },
  "needs-install": { icon: CircleAlert, tone: "text-amber-500", title: (job) => `${job.host} needs the runtime images` },
  failed: { icon: CircleX, tone: "text-destructive", title: (job) => `Couldn’t connect to ${job.host}` },
}

// Connects an SSH host as a sandbox location. Calls onConnected(job) once the
// remote gateway is ready; it never reloads the page.
export function RemoteConnect({ onConnected, onBack, initialHost }) {
  const [connections, setConnections] = React.useState(null)
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
  const chosen = React.useRef(null)
  const done = React.useRef(false)
  const prefix = React.useId()

  const finish = React.useCallback((next) => {
    if (done.current) return
    done.current = true
    onConnected(next)
  }, [onConnected])

  React.useEffect(() => {
    const controller = new AbortController()
    const id = ++generation.current
    const timeout = setTimeout(() => controller.abort(new Error("Reading hosts timed out. Try refreshing.")), 10_000)
    setRefreshing(true); setError(null); setPollError(null)
    api.connections(controller.signal).then((next) => {
      if (generation.current !== id) return
      setConnections(next)
      const resumable = next.job?.host && PENDING.includes(next.job.status) ? next.job : null
      if (resumable) { setJob(resumable); setRuntimeInstallation(resumable.runtimeInstallation || "download") }
      const host = resumable?.host ?? chosen.current ?? initialHost ?? next.active?.host
      setSelection(next.hosts.some((item) => item.name === host) ? host : next.hosts[0]?.name || "")
    }).catch((reason) => {
      if (generation.current === id && reason.name !== "AbortError") setError(reason.message)
    }).finally(() => { clearTimeout(timeout); if (generation.current === id) setRefreshing(false) })
    return () => { controller.abort(); clearTimeout(timeout); generation.current += 1 }
  }, [revision, initialHost])

  React.useEffect(() => {
    if (job?.status !== "working" || pollError || busy) return
    const controller = new AbortController()
    let timer
    async function poll() {
      try {
        const next = await api.connectionJob(job.id, controller.signal)
        if (controller.signal.aborted) return
        setJob(next)
        if (next.status === "ready") finish(next)
        else if (next.status === "working") timer = setTimeout(poll, 1000)
      } catch (reason) {
        if (!controller.signal.aborted) setPollError(reason.message)
      }
    }
    timer = setTimeout(poll, 500)
    return () => { controller.abort(); clearTimeout(timer) }
  }, [job?.id, job?.status, pollError, busy, finish])

  async function run(kind, operation) {
    setBusy(kind); setError(null); setPollError(null)
    try {
      const next = await operation()
      setJob(next)
      if (next.status === "ready") finish(next)
    } catch (reason) {
      setError(reason.message)
    } finally {
      setBusy(null)
    }
  }

  const hosts = connections?.hosts ?? []
  const selected = hosts.find((item) => item.name === selection)
  const locked = Boolean(busy) || job?.status === "working"
  const blocked = job?.status === "needs-install" || job?.status === "needs-docker"
  const missingSsh = connections && !connections.tools.ssh
  const status = job && job.host === selection && STATUS[job.status] ? STATUS[job.status] : null
  const refresh = () => setRevision((value) => value + 1)

  return <div className="grid gap-6 text-xs">
    <div className="grid gap-6 md:grid-cols-2 md:gap-8">
    <div className="grid min-w-0 content-start gap-5">
    <HostLink host={selection || "Your server"} live={job?.status === "working"} />
    </div>

    <div className="grid min-w-0 content-start gap-5">
    <div className="grid gap-2">
      <Label htmlFor={`${prefix}-host`} className="text-xs">SSH host</Label>
      <div className="flex gap-2">
        <SelectField id={`${prefix}-host`} className="flex-1" value={selected ? selection : ""} disabled={locked || !hosts.length}
          onChange={(event) => { chosen.current = event.target.value; setSelection(event.target.value); setJob(null); setFile(null); setError(null); setPollError(null) }}>
          <option value="" disabled>{hosts.length ? "Choose a host" : "No hosts in ~/.ssh/config"}</option>
          {hosts.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
        </SelectField>
        <Button type="button" variant="outline" size="icon" aria-label="Refresh hosts" disabled={Boolean(busy) || refreshing} onClick={refresh}>
          <RefreshCw className={`size-3.5 ${refreshing ? "animate-spin motion-reduce:animate-none" : ""}`} />
        </Button>
      </div>
      {selected && <p className="text-muted-foreground">First time? Run <code className="rounded bg-muted px-1 font-mono text-foreground">ssh {selection}</code> once to trust the machine.</p>}
      {missingSsh && <Notice>OpenSSH isn’t installed on this computer. Install it, then refresh.</Notice>}
    </div>

    <Details>
      <div className="grid gap-1.5">
        <p className="font-medium text-foreground">If the host is missing the runtime images</p>
        <div role="radiogroup" aria-label="Runtime images" className="inline-flex w-fit rounded-lg bg-muted p-0.5">
          {[["download", "Download on host"], ["upload", "I’ll upload a package"]].map(([value, label]) => (
            <button key={value} type="button" role="radio" aria-checked={runtimeInstallation === value} disabled={locked || blocked} onClick={() => setRuntimeInstallation(value)}
              className={`rounded-md px-2.5 py-1 transition-colors disabled:opacity-60 ${runtimeInstallation === value ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>{label}</button>
          ))}
        </div>
      </div>
      <ul className="grid list-disc gap-1.5 pl-4">
        <li>Needs Linux with Docker. On Ubuntu or Debian, ShellOS can install Docker (it asks first; needs passwordless sudo).</li>
        <li>Docker access is admin access. Connect only to machines you trust.</li>
        <li>The host gets credentials for its own gateway, never your main one.</li>
        <li>The link runs inside ShellOS on this computer. Stopping ShellOS disconnects it; disconnect any time from the gateway menu in the sidebar.</li>
      </ul>
    </Details>
    </div>
    </div>

    {status && <div role="status" aria-live="polite" className="grid gap-3 rounded-xl border border-border bg-muted/20 p-4">
      <div className="flex items-start gap-3">
        <status.icon className={`mt-0.5 size-4 shrink-0 ${status.tone}`} />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-foreground">{status.title(job)}</p>
          {job.stage && job.stage !== "Connection failed" && <p className="mt-0.5 break-words whitespace-pre-wrap text-muted-foreground">{job.stage}</p>}
        </div>
      </div>
      {job.probe && <div className="flex flex-wrap gap-1.5">
        {[`${job.probe.os || "Unknown OS"} · ${job.probe.arch || "?"}`, job.probe.dockerInstalled === false ? "No Docker" : "Docker found", job.probe.runtimeReady ? "Images ready" : "Images missing"].map((fact) => (
          <span key={fact} className="rounded-full border border-border bg-background px-2 py-0.5 text-[10px] text-muted-foreground">{fact}</span>
        ))}
      </div>}

      {job.status === "needs-docker" && (job.probe?.dockerInstallSupported ? <div className="grid gap-2 border-t border-border pt-3">
        <p className="text-muted-foreground">ShellOS will install <code className="font-mono">docker.io</code>, start it, and add your SSH user to the <code className="font-mono">docker</code> group (root-equivalent). Nothing changes unless you approve.</p>
        <Button type="button" size="sm" className="justify-self-start" disabled={locked} onClick={() => run("docker", () => api.installConnectionDocker(job.id))}>{busy === "docker" ? "Starting…" : "Install Docker and continue"}</Button>
      </div> : <div className="grid gap-2 border-t border-border pt-3">
        <p className="text-muted-foreground">{job.probe?.dockerInstallReason || "Automatic install works on Ubuntu and Debian only."} Install Docker yourself, then check again.</p>
        <Button type="button" variant="outline" size="sm" className="justify-self-start" disabled={locked} onClick={() => run("connect", () => api.connect({ host: job.host, runtimeInstallation }))}>Check again</Button>
      </div>)}

      {job.status === "needs-install" && <div className="grid gap-2 border-t border-border pt-3">
        <Button type="button" variant="outline" size="sm" className="justify-self-start" disabled={locked} onClick={() => run("download", () => api.installConnectionRuntime(job.id))}>{busy === "download" ? "Starting download…" : "Download on host"}</Button>
        <p className="text-muted-foreground">Or upload a <code className="font-mono">docker save</code> .tar for this host’s architecture.</p>
        <div className="flex gap-2">
          <Input aria-label="Docker-save package (.tar)" type="file" accept=".tar,application/x-tar" className="h-8 flex-1 text-xs" disabled={locked} onChange={(event) => { setFile(event.target.files?.[0] ?? null); setError(null) }} />
          <Button type="button" variant="outline" size="sm" disabled={locked || !file?.name.toLowerCase().endsWith(".tar")} onClick={() => run("upload", () => api.uploadConnectionPackage(job.id, file))}>{busy === "upload" ? "Uploading…" : "Upload"}</Button>
        </div>
        {file && !file.name.toLowerCase().endsWith(".tar") && <Notice>Choose an uncompressed .tar archive.</Notice>}
      </div>}
    </div>}

    {(error || (status && job.error)) && <Notice>{error || job.error}</Notice>}
    {pollError && <Notice>Lost track of progress: {pollError} It may still be running. Refresh to check.</Notice>}

    <div className="flex items-center justify-end gap-2 border-t border-border pt-4">
      <Button type="button" variant="ghost" className="mr-auto" disabled={Boolean(busy)} onClick={onBack}>Back</Button>
      <Button type="button" disabled={locked || !selected || missingSsh || blocked} onClick={() => run("connect", () => api.connect({ host: selection, runtimeInstallation }))}
        className="bg-[var(--action)] text-[var(--action-foreground)] hover:bg-[var(--action)]/90">
        {busy === "connect" || job?.status === "working" ? <><Loader2 className="size-3.5 animate-spin" />Connecting…</> : job?.status === "failed" && job.host === selection ? "Try again" : "Connect"}
      </Button>
    </div>
  </div>
}

function Notice({ children }) {
  return <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 break-words whitespace-pre-wrap text-destructive">{children}</p>
}

function Details({ children }) {
  const [open, setOpen] = React.useState(false)
  return <div>
    <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}
      className="flex w-full items-center gap-2 rounded text-left text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
      <Info className="size-3.5" />Requirements &amp; safety
      <ChevronDown className={`ml-auto size-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
    </button>
    {open && <div className="grid gap-4 pt-3 text-muted-foreground">{children}</div>}
  </div>
}

export function HostLink({ host, live }) {
  const container = React.useRef(null)
  const from = React.useRef(null)
  const to = React.useRef(null)
  const node = (ref, Icon, title, caption) => <div className="z-10 flex flex-col items-center gap-2 text-center">
    <span ref={ref} className="flex size-11 items-center justify-center rounded-2xl border border-border bg-background shadow-sm"><Icon className="size-5" /></span>
    <span>
      <span className="block max-w-32 truncate font-medium text-foreground">{title}</span>
      <span className="block text-[10px] text-muted-foreground">{caption}</span>
    </span>
  </div>
  return <div ref={container} className="relative flex items-start justify-between overflow-hidden rounded-xl border border-border bg-muted/20 px-8 py-4">
    {node(from, Laptop, "This computer", "Gateway")}
    <span className="absolute top-[38px] left-1/2 z-10 -translate-x-1/2 -translate-y-1/2 rounded-full border border-border bg-background px-2 py-0.5 font-mono text-[10px] text-muted-foreground">ssh</span>
    {node(to, Server, host, "Docker · sandboxes")}
    <AnimatedBeam containerRef={container} fromRef={from} toRef={to} duration={live ? 2.5 : 5} pathOpacity={0.25} gradientStartColor="#f59e0b" gradientStopColor="#10b981" />
  </div>
}
