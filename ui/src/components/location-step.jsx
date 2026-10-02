import * as React from "react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { ArrowLeft, ArrowUpRight, Loader2 } from "lucide-react"

import { RemoteConnect } from "@/components/remote-connect"
import { AnimatedBeam } from "@/components/ui/animated-beam"
import { Button } from "@/components/ui/button"
import { DotPattern } from "@/components/ui/dot-pattern"
import { DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { api } from "@/lib/api"
import { connectLocalGateway } from "@/lib/locations"

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

// Line drawings in currentColor so they sit on the dot grid in either theme.
export function LaptopArt({ live }) {
  const reduce = useReducedMotion()
  const id = React.useId()
  return <svg viewBox="0 0 72 48" className="h-16 w-auto text-foreground" aria-hidden="true">
    <defs>
      <linearGradient id={`${id}-screen`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="currentColor" stopOpacity="0.14" />
        <stop offset="1" stopColor="currentColor" stopOpacity="0.03" />
      </linearGradient>
    </defs>
    <rect x="10" y="2" width="52" height="34" rx="3.5" fill="var(--popover)" stroke="currentColor" strokeOpacity="0.55" />
    <rect x="13.5" y="5.5" width="45" height="27" rx="1.5" fill={`url(#${id}-screen)`} />
    <rect x="18" y="11" width="14" height="1.6" rx="0.8" fill="currentColor" fillOpacity="0.45" />
    <rect x="18" y="16" width="22" height="1.6" rx="0.8" fill="currentColor" fillOpacity="0.3" />
    <rect x="18" y="21" width="9" height="1.6" rx="0.8" fill="#10b981" fillOpacity="0.8" />
    <motion.rect x="29" y="20.3" width="3" height="3" rx="0.5" fill="currentColor" fillOpacity="0.7"
      animate={reduce || !live ? undefined : { opacity: [1, 0, 1] }} transition={{ duration: 1.1, repeat: Infinity, times: [0, 0.5, 1] }} />
    <path d="M2 38.5h68l-2.6 5.2a2.5 2.5 0 0 1-2.2 1.3H6.8a2.5 2.5 0 0 1-2.2-1.3Z" fill="var(--popover)" stroke="currentColor" strokeOpacity="0.55" strokeLinejoin="round" />
    <rect x="30" y="38.5" width="12" height="1.6" rx="0.8" fill="currentColor" fillOpacity="0.35" />
  </svg>
}

export function ServerArt({ live }) {
  const reduce = useReducedMotion()
  return <svg viewBox="0 0 52 50" className="h-[60px] w-auto text-foreground" aria-hidden="true">
    {[0, 1, 2].map((unit) => <g key={unit}>
      <rect x="2" y={2 + unit * 16} width="48" height="13" rx="3" fill="var(--popover)" stroke="currentColor" strokeOpacity="0.55" />
      <>
        <motion.circle cx="9" cy={8.5 + unit * 16} r="1.6" fill="#10b981"
          initial={{ opacity: 0.9 }} animate={reduce || !live ? undefined : { opacity: [0.9, 0.25, 0.9] }} transition={{ duration: 1.6, repeat: Infinity, delay: unit * 0.35 }} />
        <circle cx="14.5" cy={8.5 + unit * 16} r="1.6" fill="currentColor" fillOpacity="0.25" />
        {[0, 1, 2, 3].map((vent) => <rect key={vent} x={30 + vent * 4.2} y={5.5 + unit * 16} width="1.6" height="6" rx="0.8" fill="currentColor" fillOpacity="0.22" />)}
      </>
    </g>)}
  </svg>
}

function CloudArt() {
  return <svg viewBox="0 0 76 48" className="h-16 w-auto text-foreground" aria-hidden="true">
    {/* The top arc rises above y=0, so the drawing sits 3 units lower. */}
    <g transform="translate(0 3)">
      <path d="M20 42a14 14 0 0 1-1.6-27.9A18 18 0 0 1 52.6 10 13 13 0 0 1 56 42Z" fill="var(--popover)" stroke="currentColor" strokeOpacity="0.55" strokeLinejoin="round" />
      {[0, 1, 2].map((unit) => <rect key={unit} x={24 + unit * 10} y="26" width="7" height="7" rx="1.5" fill="currentColor" fillOpacity={0.3 - unit * 0.07} />)}
    </g>
  </svg>
}

// The little scene at the top of each card: where the sandbox will physically run.
function Scene({ kind, live }) {
  const container = React.useRef(null)
  const from = React.useRef(null)
  const to = React.useRef(null)
  return <div ref={container} className="relative flex h-36 items-center justify-center gap-14">
    <DotPattern width={14} height={14} className="text-foreground/15 transition-colors duration-500 [mask-image:radial-gradient(160px_circle_at_center,white,transparent)] group-hover:text-foreground/30" />
    {kind === "cloud" && <span className="relative z-10"><CloudArt /></span>}
    {kind === "local" && <span className="relative z-10 transition-transform duration-500 group-hover:scale-105"><LaptopArt live={live} /></span>}
    {kind === "remote" && <>
      <span ref={from} className="relative z-10 transition-transform duration-500 group-hover:-translate-x-1"><LaptopArt live={live} /></span>
      <span ref={to} className="relative z-10 transition-transform duration-500 group-hover:translate-x-1"><ServerArt live={live} /></span>
      <AnimatedBeam containerRef={container} fromRef={from} toRef={to} duration={live ? 2.5 : 4} pathOpacity={0.3} gradientStartColor="#f59e0b" gradientStopColor="#10b981" />
    </>}
  </div>
}

function Place({ index, scene, live, title, caption, tone = "idle", disabled, onClick, trailing }) {
  const reduce = useReducedMotion()
  const move = (event) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    event.currentTarget.style.setProperty("--x", `${event.clientX - bounds.left}px`)
    event.currentTarget.style.setProperty("--y", `${event.clientY - bounds.top}px`)
  }
  return <motion.button type="button" disabled={disabled} onClick={onClick} onPointerMove={move}
    initial={reduce ? false : { opacity: 0, y: 10 }} animate={{ opacity: disabled ? 0.5 : 1, y: 0 }} transition={{ duration: 0.35, delay: index * 0.07, ease: [0.22, 1, 0.36, 1] }}
    className="group relative block w-full overflow-hidden rounded-2xl bg-muted/30 text-left outline-none transition-colors duration-300 hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:ring-1 focus-visible:ring-foreground/20 disabled:pointer-events-none">
    <span aria-hidden="true" className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
      style={{ background: "radial-gradient(260px circle at var(--x, 50%) var(--y, 50%), color-mix(in oklab, var(--foreground) 7%, transparent), transparent 70%)" }} />
    <Scene kind={scene} live={live} />
    <span className="relative flex items-center gap-3 px-4 pt-1 pb-4">
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{title}</span>
        <span className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
          {tone !== "idle" && <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${tone === "live" ? "bg-emerald-500" : "bg-amber-500"}`} />}
          {caption}
        </span>
      </span>
      {trailing || <ArrowUpRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground transition-all duration-300 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-foreground" />}
    </span>
  </motion.button>
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
      await connectLocalGateway(api, locals[0].name)
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

    <div className="-m-2 min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-2">
      <AnimatePresence mode="wait" initial={false}>
        {view === "choose" ? <motion.div key="choose" {...slide} className="grid gap-3">
          <div className={`grid gap-4 ${allowRemote ? "sm:grid-cols-3" : ""}`}>
          <Place index={0} scene="local" live={local?.connected} title="This computer" caption={localCaption} tone={local?.connected ? "live" : "idle"}
            disabled={local ? !local.connected : !locals?.length || localBusy}
            onClick={() => local ? onPick(local.id ?? local.context) : chooseRegisteredLocal()}
            trailing={localBusy && <Loader2 className="size-4 animate-spin text-muted-foreground" />} />
          {allowRemote && <Place index={1} scene="remote" live={remote?.connected} title="Remote machine"
            caption={remote?.connected ? `Connected · ${hostOf(remote)}` : remote ? `${hostOf(remote)} · Disconnected` : "Your server, over SSH"}
            tone={remote?.connected ? "live" : remote ? "warn" : "idle"} onClick={() => setView("remote")} />}
          {allowRemote && <Place index={2} scene="cloud" title="Cloud" caption="Coming soon" disabled trailing={<span aria-hidden="true" />} />}
          </div>
          {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
          <div className="mt-3 flex justify-end">
            <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
          </div>
        </motion.div> : <motion.div key="remote" {...slide}>
          {connecting ? <div role="status" className="grid place-items-center gap-3 py-16 text-xs text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />Connected. Opening the sandbox form…
          </div> : <RemoteConnect initialHost={remote ? hostOf(remote) : undefined} connectedHost={remote?.connected ? hostOf(remote) : null} onUseConnected={() => onPick(remote.id ?? remote.context)} onConnected={onConnected} onBack={() => setView("choose")} />}
        </motion.div>}
      </AnimatePresence>
    </div>
  </div>
}
