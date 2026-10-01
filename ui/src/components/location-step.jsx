import * as React from "react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { ArrowLeft, Laptop, Loader2, Plus, Server } from "lucide-react"

import { RemoteConnect } from "@/components/remote-connect"
import { Button } from "@/components/ui/button"
import { DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { api } from "@/lib/api"

export function StepTrail({ step }) {
  return <ol aria-label="Steps" className="flex items-center gap-2 text-[11px] text-muted-foreground">
    {["Location", "Sandbox"].map((label, index) => {
      const current = index + 1 === step
      const finished = index + 1 < step
      return <React.Fragment key={label}>
        {index > 0 && <span aria-hidden="true" className={`h-px w-6 transition-colors ${finished || current ? "bg-foreground/40" : "bg-border"}`} />}
        <li aria-current={current ? "step" : undefined} className={`flex items-center gap-1.5 transition-colors ${current ? "text-foreground" : ""}`}>
          <span className={`flex size-4 items-center justify-center rounded-full text-[9px] font-semibold transition-colors ${current ? "bg-foreground text-background" : finished ? "bg-foreground/15 text-foreground" : "border border-border"}`}>{index + 1}</span>
          {label}
        </li>
      </React.Fragment>
    })}
  </ol>
}

const hostOf = (location) => location?.label?.replace(/^SSH · /, "") ?? location?.gateway

function Place({ icon: Icon, title, caption, tone = "idle", disabled, onClick, trailing }) {
  return <button type="button" disabled={disabled} onClick={onClick}
    className="group relative flex min-h-36 w-full flex-col items-start justify-between gap-6 rounded-xl border border-border p-5 text-left transition-all outline-none hover:-translate-y-0.5 hover:border-foreground/30 hover:bg-muted/30 hover:shadow-sm focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 motion-reduce:hover:translate-y-0">
    <span className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-border bg-muted/40 transition-colors group-hover:bg-background"><Icon className="size-5" /></span>
    <span className="w-full min-w-0">
      <span className="block truncate text-sm font-medium">{title}</span>
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {tone !== "idle" && <span aria-hidden="true" className={`size-1.5 rounded-full ${tone === "live" ? "bg-emerald-500" : "bg-amber-500"}`} />}
        {caption}
      </span>
    </span>
    {trailing && <span className="absolute top-5 right-5">{trailing}</span>}
  </button>
}

export function LocationStep({ locations, allowRemote, onPick, onConnected, onCancel, connecting }) {
  const reduce = useReducedMotion()
  const [view, setView] = React.useState("choose")
  const [locals, setLocals] = React.useState(null)
  const [localBusy, setLocalBusy] = React.useState(false)
  const [error, setError] = React.useState(null)
  const local = locations.find((location) => !location.remote)
  const remote = locations.find((location) => location.remote)

  // Before any gateway is chosen, the inventory has no Local entry; offer the registered gateway instead.
  React.useEffect(() => {
    if (local || !allowRemote) return
    let alive = true
    api.connections().then((next) => { if (alive) setLocals(next.locals) }).catch(() => { if (alive) setLocals([]) })
    return () => { alive = false }
  }, [local, allowRemote])

  async function chooseRegisteredLocal() {
    setLocalBusy(true); setError(null)
    try {
      await api.connect({ localGateway: locals[0].name })
      window.location.reload()
    } catch (reason) { setError(reason.message); setLocalBusy(false) }
  }

  const slide = reduce ? {} : { initial: { opacity: 0, x: view === "remote" ? 24 : -24 }, animate: { opacity: 1, x: 0 }, exit: { opacity: 0, x: view === "remote" ? -24 : 24 }, transition: { duration: 0.22, ease: [0.22, 1, 0.36, 1] } }
  const localCaption = local ? (local.connected ? "Local gateway" : "Disconnected") : locals?.length ? `Use ${locals[0].name}` : locals ? "No local gateway running" : "Checking…"

  return <div className="flex min-h-0 flex-col gap-6 rounded-xl bg-popover p-7 ring-1 ring-foreground/10">
    <DialogHeader className="gap-3">
      <StepTrail step={1} />
      <div className="flex items-center gap-2">
        {view === "remote" && <Button type="button" variant="ghost" size="icon-sm" aria-label="Back to locations" onClick={() => setView("choose")}><ArrowLeft /></Button>}
        <DialogTitle>{view === "remote" ? "Connect a machine" : "Where should it run?"}</DialogTitle>
      </div>
      <DialogDescription className={view === "remote" ? "sr-only" : "text-xs"}>{view === "remote" ? "Connect an SSH host to run sandboxes on." : "Pick a location for this sandbox."}</DialogDescription>
    </DialogHeader>

    <div className="-mx-1 min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-1">
      <AnimatePresence mode="wait" initial={false}>
        {view === "choose" ? <motion.div key="choose" {...slide} className="grid gap-3">
          <div className={`grid gap-3 ${allowRemote && remote?.connected ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}>
          <Place icon={Laptop} title="This computer" caption={localCaption} tone={local?.connected ? "live" : "idle"}
            disabled={local ? !local.connected : !locals?.length || localBusy}
            onClick={() => local ? onPick(local.context) : chooseRegisteredLocal()}
            trailing={localBusy && <Loader2 className="size-4 animate-spin text-muted-foreground" />} />
          {allowRemote && remote?.connected && <Place icon={Server} title={hostOf(remote)} caption="Connected over SSH" tone="live" onClick={() => onPick(remote.context)} />}
          {allowRemote && <Place icon={remote?.connected ? Plus : Server}
            title={remote?.connected ? "Another machine" : remote ? `Reconnect ${hostOf(remote)}` : "Remote machine"}
            caption={remote?.connected ? "Replaces the current SSH connection" : remote ? "Disconnected" : "Your server, over SSH"}
            tone={remote && !remote.connected ? "warn" : "idle"} onClick={() => setView("remote")} />}
          </div>
          {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
          <div className="mt-3 flex justify-end">
            <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
          </div>
        </motion.div> : <motion.div key="remote" {...slide}>
          {connecting ? <div role="status" className="grid place-items-center gap-3 py-16 text-xs text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />Connected. Opening the sandbox form…
          </div> : <RemoteConnect initialHost={remote && !remote.connected ? hostOf(remote) : undefined} onConnected={onConnected} onBack={() => setView("choose")} />}
        </motion.div>}
      </AnimatePresence>
    </div>
  </div>
}
