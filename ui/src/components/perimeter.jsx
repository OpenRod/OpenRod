import * as React from "react"
import { motion, useReducedMotion } from "motion/react"
import { Ban, Bot, Box, Check, ChevronDown, KeyRound, Network, Plug, BookOpen, Server, UserRound } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { ShineBorder } from "@/components/ui/shine-border"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { SOURCE, brandOf } from "@/lib/policy-sources"
import { cn } from "@/lib/utils"

export function HostTile({ host, tone = "default", className }) {
  return <span aria-hidden="true" className={cn("flex size-6 shrink-0 items-center justify-center rounded-md border font-sans text-xs font-medium", tone === "denied" ? "border-red-200/60 bg-red-50 text-red-700" : "border-border bg-muted/50 text-muted-foreground", className)}>{brandOf(host).charAt(0).toUpperCase()}</span>
}

const Node = React.forwardRef(function Node({ item, denied, active, onFocus, onBlur, onAllow }, ref) {
  const source = SOURCE[item.source] ?? SOURCE.own
  return <div ref={ref} className={cn("relative z-10 flex h-[23px] w-full min-w-0 items-center rounded-md border bg-card transition-colors", active ? "border-stone-400" : "border-border/80")}>
    <Tooltip>
      <TooltipTrigger render={<button type="button" />} onMouseEnter={onFocus} onMouseLeave={onBlur} onFocus={onFocus} onBlur={onBlur}
        aria-label={`${item.host}, ${denied ? `${item.count} blocked attempts` : `allowed · ${source.label}`}`}
        className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-md px-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span className="min-w-0 flex-1 truncate text-[11px] text-foreground">{item.host}</span>
        {denied ? <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{item.count}×</span> : <span className={cn("size-1 shrink-0 rounded-full", source.swatch)} />}

      </TooltipTrigger>
      <TooltipContent className="max-w-sm break-all font-sans">{item.host} · {denied ? "Blocked in recent activity" : `Allowed · ${source.label}`}</TooltipContent>
    </Tooltip>
    {denied && onAllow && <Button size="sm" variant="ghost" className="mr-1 px-2 text-[11px]" onClick={onAllow}>Review</Button>}
  </div>
})

const Group = React.forwardRef(function Group({ title, count, icon: Icon, summary, open, onToggle, tone = "neutral", children, className, ...props }, ref) {
  const id = React.useId()
  return <section ref={ref} {...props} className={cn("relative z-10 min-w-0 overflow-hidden rounded-none border shadow-[0_2px_6px_#1c191703]", tone === "blocked" ? "border-red-200/60 bg-[var(--graph-blocked)]" : tone === "allowed" ? "border-emerald-200/60 bg-[var(--graph-allowed)]" : "border-stone-200 bg-[var(--graph-neutral)]", className)}>
    <button type="button" aria-expanded={open} aria-controls={id} aria-label={`${open ? "Collapse" : "Expand"} ${title}`} onClick={onToggle}
      className="group flex w-full items-center gap-2.5 rounded-none px-4 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
      <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-full border bg-card", tone === "blocked" ? "border-red-200/60 text-red-500" : tone === "allowed" ? "border-emerald-200/60 text-emerald-600" : "border-border text-stone-500")}><Icon className="size-3.5" strokeWidth={1.5} /></span>
      <span className="min-w-0 flex-1"><span className="flex items-center gap-2 text-[11px] font-medium">{title}<span className="text-[10px] font-normal tabular-nums text-muted-foreground">{count}</span></span><span className="mt-0.5 block truncate text-[10px] text-muted-foreground" title={summary}>{summary}</span></span>
      <ChevronDown className={cn("size-3 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none", open && "rotate-180")} />
    </button>
    <motion.div id={id} initial={false} animate={{ height: open ? "auto" : 0, opacity: open ? 1 : 0 }} transition={{ duration: useReducedMotion() ? 0 : 0.22, ease: [0.22, 1, 0.36, 1] }} inert={!open} aria-hidden={!open} className="overflow-hidden">
      <div className="space-y-0.5 border-t border-black/5 p-2">{children}</div>
    </motion.div>
  </section>
})

// Keep the grid as the default layout and translate only the node being moved.
function Draggable({ children, canvas, label }) {
  const [offset, setOffset] = React.useState({ x: 0, y: 0 })
  const gesture = React.useRef(null)
  const suppressClick = React.useRef(false)
  const clamp = (element, x, y) => {
    const bounds = canvas.current.getBoundingClientRect()
    const rect = element.getBoundingClientRect()
    const scale = bounds.width / canvas.current.offsetWidth || 1
    const left = (rect.left - bounds.left) / scale - offset.x
    const top = (rect.top - bounds.top) / scale - offset.y
    return {
      x: Math.max(-left, Math.min(x, bounds.width / scale - left - rect.width / scale)),
      y: Math.max(-top, Math.min(y, bounds.height / scale - top - rect.height / scale)),
    }
  }
  React.useLayoutEffect(() => {
    canvas.current?.dispatchEvent(new Event("graph-move"))
  }, [offset, canvas])
  return React.cloneElement(children, {
    tabIndex: 0,
    "aria-label": `${label}. Drag to move or use arrow keys`,
    className: cn(children.props.className, "cursor-grab touch-none select-none outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"),
    style: { ...children.props.style, transform: `translate(${offset.x}px, ${offset.y}px)`, zIndex: gesture.current?.moved ? 30 : 10 },
    onDragStart: (event) => event.preventDefault(),
    onPointerDown: (event) => {
      if (event.button !== 0 || !event.isPrimary || event.target.closest("[data-resource-list]")) return
      // Group headers remain clickable; their contents keep normal interactions.
      if (event.target.closest("button") && !event.target.closest("button[aria-expanded], [data-graph-drag-handle]")) return
      suppressClick.current = false
      gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY, offset, moved: false }
    },
    onPointerLeave: () => { if (!gesture.current?.moved) gesture.current = null },
    onPointerMove: (event) => {
      const drag = gesture.current
      if (!drag || drag.id !== event.pointerId) return
      const dx = event.clientX - drag.x
      const dy = event.clientY - drag.y
      if (!drag.moved && Math.hypot(dx, dy) < 5) return
      drag.moved = true
      suppressClick.current = true
      event.currentTarget.setPointerCapture(event.pointerId)
      const scale = canvas.current.getBoundingClientRect().width / canvas.current.offsetWidth || 1
      setOffset(clamp(event.currentTarget, drag.offset.x + dx / scale, drag.offset.y + dy / scale))
    },
    onPointerUp: (event) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
      gesture.current = null
      setOffset((value) => ({ ...value }))
    },
    onPointerCancel: () => { gesture.current = null; suppressClick.current = false },
    onLostPointerCapture: () => { gesture.current = null },
    onClickCapture: (event) => {
      if (suppressClick.current) { event.preventDefault(); event.stopPropagation(); suppressClick.current = false }
    },
    onKeyDown: (event) => {
      if (event.target !== event.currentTarget) return
      const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key]
      if (!direction) return
      event.preventDefault()
      const step = event.shiftKey ? 20 : 5
      setOffset(clamp(event.currentTarget, offset.x + direction[0] * step, offset.y + direction[1] * step))
    },
  })
}

export function Perimeter({ name, phase, agents = [], agentStatus = "Agent inventory not checked", allowed, denied, onAllow, compact = false, fill = false, owner = "Not reported", secrets = [], gateway }) {
  const container = React.useRef(null)
  const core = React.useRef(null)
  const hub = React.useRef(null)
  const groups = React.useMemo(() => ({ agents: React.createRef(), owner: React.createRef(), secrets: React.createRef(), blocked: React.createRef(), allowed: React.createRef() }), [])
  const [layoutVersion, resetLayout] = React.useReducer((value) => value + 1, 0)
  React.useEffect(() => {
    let width = container.current?.clientWidth
    const observer = new ResizeObserver(() => {
      const next = container.current?.clientWidth
      if (next !== width) { width = next; resetLayout() }
    })
    observer.observe(container.current)
    return () => observer.disconnect()
  }, [])
  const [expanded, setExpanded] = React.useState({})
  const [active, setActive] = React.useState(null)
  const toggle = (key) => setExpanded((previous) => ({ ...previous, [key]: !previous[key] }))
  const expandableGroups = ["secrets", "blocked", "allowed", ...agents.flatMap((agent) => [`${agent.name}:mcps`, `${agent.name}:skills`])]
  const allOpen = expandableGroups.every((key) => expanded[key])
  return <TooltipProvider delay={150}>
    <div className={cn("@container flex flex-col overflow-hidden rounded-xl border border-border/70 bg-card font-sans", fill && "flex-1")} aria-label={`Access graph for ${name}`}>
      <div className="flex items-center justify-end gap-3 border-b border-border/50 px-4 py-1.5">
        <div className="flex shrink-0 items-center gap-3"><button type="button" onClick={resetLayout} className="rounded px-1 text-[10px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">Reset layout</button>
        <button type="button" onClick={() => setExpanded(Object.fromEntries(expandableGroups.map((key) => [key, !allOpen])))} className="rounded px-1 text-[10px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">{allOpen ? "Collapse all" : "Expand all"}</button></div>
      </div>
      <div ref={container} className={cn("relative mx-auto grid w-full flex-1 max-w-[1020px] grid-cols-1 items-center gap-5 px-4 @2xl:grid-cols-[minmax(0,1fr)_160px_minmax(0,1.3fr)] @2xl:gap-x-8 @2xl:gap-y-7 @2xl:px-6", compact ? "py-3" : "py-7")}>
        <div ref={groups.agents} aria-label="Agent types" className="relative z-10 order-3 flex flex-col items-center gap-7 @2xl:order-none @2xl:col-start-1 @2xl:row-start-1 @2xl:row-span-4">
          {(agents.length ? agents : [{ name: agentStatus, logo: null }]).map((agent) => <Draggable key={`${name}-${layoutVersion}-${agent.name}`} canvas={container} label={agent.name}><div className="flex w-full max-w-[280px] flex-col items-center gap-2">
            <Card data-agent-node className="relative isolate size-[52px] shrink-0 items-center justify-center gap-0 overflow-visible rounded-[14px] border-stone-300/80 bg-gradient-to-b from-stone-50 to-stone-100 p-1.5 shadow-[0_3px_0_-1px_var(--color-stone-200),0_3px_0_0_var(--edge-neutral),0_6px_10px_-5px_#1c191725,inset_0_1px_0_var(--frame-highlight)]">
              <ShineBorder shineColor={["var(--edge-neutral)", "var(--frame-highlight)", "var(--ink-faint)"]} duration={18} aria-hidden="true" />
              <div className="flex size-full items-center justify-center rounded-[9px] border border-stone-200/80 bg-card shadow-[inset_0_2px_4px_#1c191708,0_1px_0_var(--frame-highlight)]">
                {agent.logo ? <img src={agent.logo} alt="" className="size-6 object-contain" /> : <Bot className="size-5 text-muted-foreground" strokeWidth={1.3} aria-hidden="true" />}
              </div>
            </Card>
            <span className="max-w-full break-words bg-card px-2 text-center text-xs font-medium">{agent.name}</span>
            {agents.length > 0 && <div className="relative w-full pt-4 before:absolute before:left-1/2 before:top-0 before:h-4 before:border-l before:border-[var(--edge-neutral)]">
              <div role="group" aria-label={`${agent.name} resources`} className="overflow-hidden rounded-xl border border-border/80 bg-card shadow-[0_2px_8px_#1c191705]">
                {[{ kind: "mcps", title: "MCPs", icon: Plug }, { kind: "skills", title: "Skills", icon: BookOpen }].map(({ kind, title, icon }) => {
                  const inventory = agent.resources?.[kind]
                  const checked = inventory?.status === "checked"
                  const unsupported = inventory?.status === "unsupported"
                  const items = checked ? inventory.items : []
                  const key = `${agent.name}:${kind}`
                  return <Group key={kind} title={title} aria-label={`${agent.name} ${title}`} count={checked ? items.length : "—"} icon={icon}
                    summary={unsupported ? "Setup integration unavailable" : checked ? "In agent user configuration" : "Inventory unavailable"} open={!!expanded[key]} onToggle={() => toggle(key)}
                    className={cn("border-0 shadow-none", kind === "skills" && "border-t border-border/60")}>
                    <div data-resource-list className="max-h-48 touch-pan-y select-text space-y-0.5 overflow-y-auto overscroll-contain">
                      {items.map((item) => <div key={item.name} className="flex min-h-[23px] items-center gap-2 rounded-md border border-border/80 bg-card px-2.5 py-1 text-[11px]">
                        <span className="min-w-0 flex-1 break-words">{kind === "skills" ? item.name.replace(/^os-[a-f0-9]{8}-(?=.)/i, "") : item.name}</span>
                        {item.disabled && <span className="shrink-0 text-[10px] text-muted-foreground">Disabled</span>}
                      </div>)}
                      {!items.length && <p className="px-2 py-2 text-center text-[11px] text-muted-foreground">{unsupported ? `${title} integration unavailable` : checked ? `No ${title} found in user configuration` : `${title} inventory unavailable`}</p>}
                    </div>
                  </Group>
                })}
              </div>
            </div>}

          </div></Draggable>)}
        </div>
        <Draggable key={`${name}-${layoutVersion}-owner`} canvas={container} label="Owner"><Card ref={groups.owner} role="group" aria-label="Owner" className="relative z-10 w-max min-w-0 max-w-full justify-self-center gap-1.5 border-stone-200 bg-[var(--graph-neutral)] px-3 py-2.5 shadow-[0_2px_6px_#1c191703] @2xl:col-start-2 @2xl:row-start-1">
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <UserRound className="size-3 shrink-0" strokeWidth={1.5} aria-hidden="true" />
            <span>Owner</span>
          </div>
          <p className="min-w-0 whitespace-normal text-[11px] font-medium leading-relaxed [overflow-wrap:anywhere]">{owner}</p>
        </Card></Draggable>
        <Draggable key={`${name}-${layoutVersion}-sandbox`} canvas={container} label={name}><div ref={hub} className="relative z-10 flex min-w-0 flex-col items-center justify-self-center rounded-xl px-3 @2xl:col-start-2 @2xl:row-start-2">
          <div ref={core} className="flex size-14 items-center justify-center rounded-2xl border border-stone-300 bg-card shadow-[0_3px_8px_#1c191708]"><Box className="size-6 text-stone-600" strokeWidth={1.3} /></div>
          <p className="mt-2 max-w-[156px] truncate text-xs font-medium" title={name}>{name}</p>

        </div></Draggable>
        <Draggable key={`${name}-${layoutVersion}-gateway`} canvas={container} label="Gateway"><div className="relative z-10 flex justify-center @2xl:col-start-2 @2xl:row-start-3">
          <Tooltip><TooltipTrigger data-graph-drag-handle render={<button type="button" />} className="relative z-10 flex min-h-10 max-w-full items-center gap-1.5 bg-card px-2 text-[10px] text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"><Server className="size-3 shrink-0" strokeWidth={1.5} /><span>{gateway ? `${gateway.remote ? "Remote" : "Local"} gateway` : "Host not reported"}</span></TooltipTrigger><TooltipContent className="max-w-64 font-sans">{gateway ? `Connected through ${gateway.name}. ` : ""}The sandbox’s host machine or cloud placement is not reported.</TooltipContent></Tooltip>
        </div></Draggable>
        <Draggable key={`${name}-${layoutVersion}-network`} canvas={container} label="Network access"><section aria-label="Network access" className="relative z-10 order-4 overflow-hidden rounded-xl border border-border/80 bg-card shadow-[0_2px_8px_#1c191705] @2xl:order-none @2xl:col-start-3 @2xl:row-start-1 @2xl:row-span-4">
          <div className="flex items-center gap-2 border-b border-border/60 px-4 py-3">
            <Network className="size-3.5 text-muted-foreground" strokeWidth={1.5} aria-hidden="true" />
            <h4 className="text-[11px] font-medium">Network</h4>
            <span className="ml-auto text-[10px] text-muted-foreground">Outbound access</span>
          </div>
        <Group ref={groups.allowed} title="Approved network" count={allowed.length} icon={Check} summary="Destinations in policy" tone="allowed" open={!!expanded.allowed} onToggle={() => toggle("allowed")} className="border-0 shadow-none">
          {allowed.map((item) => <Node key={item.host} item={item} active={active === item.host} onFocus={() => setActive(item.host)} onBlur={() => setActive(null)} />)}
          {!allowed.length && <p className="py-2 text-center text-[11px] text-muted-foreground">No approved destinations</p>}
        </Group>
        <Group ref={groups.blocked} title="Blocked network" count={denied.length} icon={Ban} summary="Recent connection attempts" tone="blocked" open={!!expanded.blocked} onToggle={() => toggle("blocked")} className="border-0 border-t border-border/60 shadow-none">
          {denied.map((item) => <Node key={item.host} item={item} denied active={active === item.host} onFocus={() => setActive(item.host)} onBlur={() => setActive(null)} onAllow={onAllow ? () => onAllow(item) : undefined} />)}
          {!denied.length && <p className="py-2 text-center text-[11px] text-muted-foreground">No blocked attempts</p>}
        </Group>
        </section></Draggable>
        <Draggable key={`${name}-${layoutVersion}-secrets`} canvas={container} label="Secrets"><Group ref={groups.secrets} title="Secrets" count={secrets.length} icon={KeyRound} summary={secrets.length ? secrets.map((secret) => secret.name).join(", ") : "None attached"} open={!!expanded.secrets} onToggle={() => toggle("secrets")} className="@2xl:col-start-2 @2xl:row-start-4">
          {secrets.map((secret) => <Tooltip key={secret.name}><TooltipTrigger render={<button type="button" />} className="block w-full truncate rounded-lg border border-border/70 bg-card px-2.5 py-1.5 text-left text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring">{secret.name}</TooltipTrigger><TooltipContent className="max-w-72 break-words font-sans">{secret.name}{secret.type ? ` · ${secret.type}` : ""}{secret.credentialKeys?.length ? ` · ${secret.credentialKeys.join(", ")}` : ""}</TooltipContent></Tooltip>)}
          {!secrets.length && <p className="py-2 text-center text-[11px] text-muted-foreground">No secrets attached</p>}
        </Group></Draggable>
        <Connections key={`${name}-${layoutVersion}-${agents.map((agent) => agent.name).join(",")}`} container={container} core={core} hub={hub} groups={groups} />
      </div>
    </div>
  </TooltipProvider>
}

// One edge per group. Observe animated bounds so connections stay attached as
// the clusters expand, collapse, or reflow with the viewport.
function Connections({ container, core, hub, groups }) {
  const svg = React.useRef(null)
  const [paths, setPaths] = React.useState([])
  React.useEffect(() => {
    function measure() {
      if (!container.current || !core.current || !hub.current) return
      const matrix = svg.current?.getScreenCTM()
      if (!matrix) return
      // DOM bounds include the dialog's opening scale. Convert them back into
      // SVG coordinates so every endpoint stays centered throughout animation.
      const inverse = matrix.inverse()
      const localBounds = (element) => {
        const rect = element.getBoundingClientRect()
        const topLeft = new DOMPoint(rect.left, rect.top).matrixTransform(inverse)
        const bottomRight = new DOMPoint(rect.right, rect.bottom).matrixTransform(inverse)
        return { left: topLeft.x, top: topLeft.y, right: bottomRight.x, bottom: bottomRight.y, width: bottomRight.x - topLeft.x, height: bottomRight.y - topLeft.y }
      }
      const box = localBounds(core.current)
      const body = localBounds(hub.current)
      const cx = box.left + box.width / 2
      const cy = box.top + box.height / 2
      setPaths(Object.entries(groups).flatMap(([key, ref]) => {
        const rect = ref.current ? localBounds(ref.current) : null
        if (!rect) return []
        if (key === "owner" || key === "secrets") {
          const sy = (key === "owner" ? box.top : body.bottom)
          const ty = (key === "owner" ? rect.bottom : rect.top)
          const tx = rect.left + rect.width / 2
          const my = (sy + ty) / 2
          return [{ key, d: `M ${cx} ${sy} C ${cx} ${my}, ${tx} ${my}, ${tx} ${ty}`, x: tx, y: ty }]
        }
        if (key === "agents") {
          return [...ref.current.querySelectorAll("[data-agent-node]")].map((node, index) => {
            const agent = localBounds(node)
            const sx = box.left
            const tx = agent.right
            const ty = agent.top + agent.height / 2
            const mx = (sx + tx) / 2
            return { key: `agent-${index}`, d: `M ${sx} ${cy} C ${mx} ${cy}, ${mx} ${ty}, ${tx} ${ty}`, x: tx, y: ty }
          })
        }
        const sx = box.right
        const tx = rect.left
        // Connect to each section's header, even when its host list expands.
        const header = localBounds(ref.current.querySelector("button"))
        const ty = header.top + header.height / 2
        const branch = sx + (tx - sx) * 0.4
        const bend = branch + (tx - branch) * 0.5
        return [{ key, d: `M ${sx} ${cy} H ${branch} C ${bend} ${cy}, ${bend} ${ty}, ${tx} ${ty}`, x: tx, y: ty }]
      }))
    }
    measure()
    const observer = new ResizeObserver(measure)
    ;[container.current, core.current, hub.current, ...Object.values(groups).map((ref) => ref.current)].filter(Boolean).forEach((element) => observer.observe(element))
    const canvas = container.current
    canvas.addEventListener("graph-move", measure)
    return () => { observer.disconnect(); canvas.removeEventListener("graph-move", measure) }
  }, [container, core, hub, groups])
  return <svg ref={svg} className="pointer-events-none absolute inset-0 hidden size-full overflow-visible @2xl:block" aria-hidden="true" fill="none">
    {paths.map((path) => <g key={path.key}><path d={path.d} stroke={path.key === "blocked" ? "var(--edge-blocked)" : path.key === "allowed" ? "var(--edge-allowed)" : "var(--edge-neutral)"} strokeWidth="1.5" strokeLinecap="round" /><circle cx={path.x} cy={path.y} r="2.5" fill="var(--card)" stroke="var(--edge-neutral)" /></g>)}
  </svg>
}
