import * as React from "react"

import { PHASE_LABEL, groupKey, imageName, statusOf } from "@/lib/sandboxes"

// The floor: every sandbox the gateway knows, one cell each, shelved by zone.
// Drawn on a canvas because ten thousand DOM nodes with tooltips is where a
// page stops scrolling; the static floor is painted once per change and only
// the live pulses, hover and selection are redrawn per frame.

const STATUS_COLOR = { running: "#10b981", sleeping: "#d6d3d1", provisioning: "#fbbf24", error: "#ef4444", unknown: "#e7e5e4" }
const QUIET = "#eceae7"
// Traffic volume on a log scale: a box that made 3 calls and one that made 300
// should both be visible, and still be told apart.
const INK = ["#d6d3d1", "#a8a29e", "#78716c", "#57534e", "#292524"]
const RED = ["#fecaca", "#f87171", "#ef4444", "#b91c1c"]
const AMBER = "#f59e0b"
const HEADER = 28
const ZONE_GAP = 18
const PAD = 16

export const LENSES = {
  status: {
    label: "Status",
    legend: [["Ready", STATUS_COLOR.running], ["Stopped", STATUS_COLOR.sleeping], ["Preparing", STATUS_COLOR.provisioning], ["Needs attention", STATUS_COLOR.error]],
  },
  traffic: {
    label: "Traffic",
    legend: [["Quiet", QUIET], ["Allowed", INK[3]], ["Denied", RED[2]]],
  },
  asks: {
    label: "Asks",
    legend: [["Waiting on you", AMBER], ["Nothing pending", QUIET]],
  },
}

function density(n) {
  if (n <= 48) return { size: 22, gap: 6 }
  if (n <= 150) return { size: 14, gap: 4 }
  if (n <= 1200) return { size: 10, gap: 3 }
  if (n <= 4000) return { size: 7, gap: 2 }
  return { size: 5, gap: 2 }
}

export function layoutFloor(items, groupBy, width) {
  const { size, gap } = density(items.length)
  const pitch = size + gap
  const cols = Math.max(4, Math.floor((width - PAD * 2 + gap) / pitch))
  const map = new Map()
  for (const s of items) {
    const key = groupKey(s, groupBy)
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(s)
  }
  const zones = []
  const flat = []
  let y = PAD - 6
  for (const [key, zoneItems] of [...map].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
    const rows = Math.ceil(zoneItems.length / cols)
    zones.push({ key, items: zoneItems, top: y, cellsTop: y + HEADER, cols, rows, start: flat.length })
    flat.push(...zoneItems)
    y += HEADER + rows * pitch - gap + ZONE_GAP
  }
  const indexOf = new Map(flat.map((s, i) => [s.name, i]))
  return { zones, flat, indexOf, size, gap, pitch, height: Math.max(y - ZONE_GAP + PAD, 120) }
}

function cellOf(layout, index) {
  const zone = layout.zones.findLast((z) => z.start <= index)
  if (!zone) return null
  const i = index - zone.start
  const row = Math.floor(i / zone.cols), col = i % zone.cols
  return { zone, row, col, x: PAD + col * layout.pitch, y: zone.cellsTop + row * layout.pitch }
}

function hit(layout, x, y) {
  const zone = layout.zones.find((z) => y >= z.cellsTop && y < z.cellsTop + z.rows * layout.pitch)
  if (!zone) return -1
  const col = Math.floor((x - PAD) / layout.pitch)
  const row = Math.floor((y - zone.cellsTop) / layout.pitch)
  if (col < 0 || col >= zone.cols) return -1
  const i = row * zone.cols + col
  return i < zone.items.length ? zone.start + i : -1
}

function colorOf(sandbox, lens, traffic, pending) {
  if (lens === "status") return STATUS_COLOR[statusOf(sandbox.phase)]
  if (lens === "asks") return pending.get(sandbox.name) ? AMBER : statusOf(sandbox.phase) === "error" ? "#fde2e2" : QUIET
  const t = traffic.get(sandbox.name)
  if (!t) return QUIET
  if (t.denied) return RED[Math.min(3, Math.floor(Math.log2(t.denied + 1)))]
  return INK[Math.min(4, Math.floor(Math.log2(t.allowed + 1)))]
}

const count = (n) => Intl.NumberFormat("en-US").format(n)

export function FleetFloor({ sandboxes, groupBy, lens, traffic, pending, match, selected, onSelect, onOpen, onZone, events, reduceMotion }) {
  const scroller = React.useRef(null)
  const canvas = React.useRef(null)
  const floor = React.useRef(null) // the painted static layer
  const pulses = React.useRef(new Map())
  const lastSeen = React.useRef(null)
  const frame = React.useRef(0)
  const [width, setWidth] = React.useState(0)
  const [hover, setHover] = React.useState(-1)

  React.useLayoutEffect(() => {
    const element = scroller.current
    if (!element) return
    const measure = () => setWidth(element.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const layout = React.useMemo(() => layoutFloor(sandboxes, groupBy, width || 800), [sandboxes, groupBy, width])
  const selectedIndex = selected ? layout.indexOf.get(selected) ?? -1 : -1

  // Paint the floor once per change of what it shows.
  React.useEffect(() => {
    if (!width) return
    const dpr = window.devicePixelRatio || 1
    const layer = floor.current ?? (floor.current = document.createElement("canvas"))
    layer.width = Math.ceil(width * dpr)
    layer.height = Math.ceil(layout.height * dpr)
    const ctx = layer.getContext("2d")
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, layout.height)
    const { size } = layout
    const radius = size >= 20 ? 4 : size >= 10 ? 2.5 : size >= 7 ? 1.5 : 1
    for (const zone of layout.zones) {
      zone.items.forEach((s, i) => {
        const x = PAD + (i % zone.cols) * layout.pitch
        const y = zone.cellsTop + Math.floor(i / zone.cols) * layout.pitch
        ctx.globalAlpha = match(s) ? 1 : 0.13
        ctx.fillStyle = colorOf(s, lens, traffic, pending)
        ctx.beginPath()
        ctx.roundRect(x, y, size, size, radius)
        ctx.fill()
        // A pending ask is worth seeing under every lens.
        if (lens !== "asks" && pending.get(s.name) && size >= 7) {
          ctx.fillStyle = AMBER
          ctx.beginPath()
          ctx.arc(x + size - 1, y + 1, Math.max(1.5, size / 5), 0, Math.PI * 2)
          ctx.fill()
        }
      })
    }
    ctx.globalAlpha = 1
    draw() // eslint-disable-line no-use-before-define
  }, [layout, lens, traffic, pending, match, width]) // eslint-disable-line react-hooks/exhaustive-deps

  // New decisions ripple out of the cell that made them.
  React.useEffect(() => {
    const head = events[0] ? `${events[0].at}|${events[0].message}` : null
    if (lastSeen.current !== null && !reduceMotion) {
      const now = performance.now()
      for (const e of events) {
        if (`${e.at}|${e.message}` === lastSeen.current) break
        if (e.kind === "audit" && e.verdict) pulses.current.set(e.sandbox, { t: now, denied: e.verdict !== "allowed" })
        if (pulses.current.size > 400) break
      }
      if (pulses.current.size) loop() // eslint-disable-line no-use-before-define
    }
    lastSeen.current = head
  }, [events]) // eslint-disable-line react-hooks/exhaustive-deps

  function draw() {
    const element = canvas.current
    if (!element || !floor.current || !width) return
    const dpr = window.devicePixelRatio || 1
    if (element.width !== floor.current.width || element.height !== floor.current.height) {
      element.width = floor.current.width
      element.height = floor.current.height
    }
    const ctx = element.getContext("2d")
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, element.width, element.height)
    ctx.drawImage(floor.current, 0, 0)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const { size } = layout
    const now = performance.now()
    for (const [name, pulse] of pulses.current) {
      const age = (now - pulse.t) / 1400
      const index = layout.indexOf.get(name)
      if (age >= 1 || index === undefined) { pulses.current.delete(name); continue }
      if (!match(layout.flat[index])) continue
      const cell = cellOf(layout, index)
      const grow = size * (0.6 + age * 1.6)
      ctx.globalAlpha = (1 - age) * 0.85
      ctx.strokeStyle = pulse.denied ? "#ef4444" : "#10b981"
      ctx.lineWidth = 1.25
      ctx.beginPath()
      ctx.arc(cell.x + size / 2, cell.y + size / 2, grow, 0, Math.PI * 2)
      ctx.stroke()
    }
    ctx.globalAlpha = 1
    if (selectedIndex >= 0) {
      const cell = cellOf(layout, selectedIndex)
      const cx = cell.x + size / 2, cy = cell.y + size / 2
      const zoneRight = PAD + (cell.zone.cols - 1) * layout.pitch + size
      const zoneBottom = cell.zone.cellsTop + cell.zone.rows * layout.pitch - layout.gap
      // Locator lines: which shelf, which slot.
      ctx.strokeStyle = "#1c1917"
      ctx.globalAlpha = 0.14
      ctx.lineWidth = 1
      ctx.setLineDash([2, 3])
      ctx.beginPath()
      ctx.moveTo(PAD - 6, cy + 0.5); ctx.lineTo(zoneRight + 6, cy + 0.5)
      ctx.moveTo(cx + 0.5, cell.zone.cellsTop - 4); ctx.lineTo(cx + 0.5, zoneBottom + 4)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.globalAlpha = 1
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.roundRect(cell.x - 2.5, cell.y - 2.5, size + 5, size + 5, 3)
      ctx.stroke()
    }
    if (hover >= 0 && hover !== selectedIndex) {
      const cell = cellOf(layout, hover)
      ctx.strokeStyle = "#78716c"
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.roundRect(cell.x - 1.5, cell.y - 1.5, size + 3, size + 3, 2.5)
      ctx.stroke()
    }
  }

  const latestDraw = React.useRef(draw)
  latestDraw.current = draw
  function loop() {
    if (frame.current) return
    const tick = () => {
      latestDraw.current()
      frame.current = pulses.current.size ? requestAnimationFrame(tick) : 0
    }
    frame.current = requestAnimationFrame(tick)
  }
  React.useEffect(() => () => cancelAnimationFrame(frame.current), [])
  React.useEffect(() => { draw() }) // hover and selection

  // Keep a keyboard-moved selection on screen.
  React.useEffect(() => {
    if (selectedIndex < 0 || !scroller.current) return
    const { y } = cellOf(layout, selectedIndex)
    const element = scroller.current
    if (y < element.scrollTop + 8) element.scrollTop = y - HEADER - 8
    else if (y + layout.size > element.scrollTop + element.clientHeight - 8) element.scrollTop = y + layout.size - element.clientHeight + 24
  }, [selectedIndex, layout])

  function onKeyDown(event) {
    const keys = { ArrowLeft: -1, ArrowRight: 1 }
    if (!layout.flat.length) return
    if (event.key === "Enter" && selectedIndex >= 0) { event.preventDefault(); onOpen(layout.flat[selectedIndex].name); return }
    if (event.key === "Escape") { onSelect(null); return }
    let next = -1
    const from = selectedIndex < 0 ? 0 : selectedIndex
    if (selectedIndex < 0 && event.key.startsWith("Arrow")) next = 0
    else if (keys[event.key]) next = Math.min(layout.flat.length - 1, Math.max(0, from + keys[event.key]))
    else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const cell = cellOf(layout, from)
      const down = event.key === "ArrowDown"
      const within = from + (down ? cell.zone.cols : -cell.zone.cols)
      const zoneIndex = layout.zones.indexOf(cell.zone)
      if (within >= cell.zone.start && within < cell.zone.start + cell.zone.items.length) next = within
      else if (down && cell.row < cell.zone.rows - 1) next = cell.zone.start + cell.zone.items.length - 1
      else {
        const target = layout.zones[zoneIndex + (down ? 1 : -1)]
        if (target) {
          const row = down ? 0 : target.rows - 1
          next = Math.min(target.start + target.items.length - 1, target.start + row * target.cols + cell.col)
        }
      }
    }
    if (next >= 0) { event.preventDefault(); onSelect(layout.flat[next].name) }
  }

  const hovered = hover >= 0 ? layout.flat[hover] : null
  const hoverCell = hovered ? cellOf(layout, hover) : null
  const hoverTraffic = hovered ? traffic.get(hovered.name) : null
  const hoverAsks = hovered ? pending.get(hovered.name) ?? 0 : 0

  return (
    <div ref={scroller} tabIndex={0} onKeyDown={onKeyDown} role="grid"
      aria-label={`${count(sandboxes.length)} sandboxes. Arrow keys move, Enter opens.`}
      className="relative min-h-0 flex-1 overflow-y-auto outline-none focus-visible:ring-1 focus-visible:ring-border focus-visible:ring-inset">
      <div className="relative" style={{ height: layout.height }}>
        {layout.zones.map((zone) => {
          const flagged = zone.items.filter((s) => statusOf(s.phase) === "error").length
          const asks = zone.items.reduce((n, s) => n + (pending.get(s.name) ?? 0), 0)
          const denied = lens === "traffic" ? zone.items.filter((s) => traffic.get(s.name)?.denied).length : 0
          return (
            <div key={zone.key} className="absolute flex h-5 items-center gap-2.5" style={{ top: zone.top, left: PAD, right: PAD }}>
              <button onClick={() => onZone(zone.key)} className="min-w-0 truncate rounded font-mono text-[11px] font-medium outline-none hover:underline hover:underline-offset-2 focus-visible:ring-2 focus-visible:ring-ring">
                {zone.key}
              </button>
              <span className="font-mono text-[10px] tabular-nums text-muted-foreground">{count(zone.items.length)}</span>
              {flagged > 0 && <span className="flex items-center gap-1 font-mono text-[10px] tabular-nums text-red-600"><span className="size-1.5 rounded-full bg-red-500" aria-hidden="true" />{count(flagged)}</span>}
              {denied > 0 && <span className="font-mono text-[10px] tabular-nums text-red-600" title="Sandboxes with a denied connection">{count(denied)}✕</span>}
              {asks > 0 && <span className="rounded bg-amber-100 px-1 font-mono text-[10px] tabular-nums text-amber-800">{count(asks)} ask</span>}
              <span className="h-px flex-1 bg-border/70" aria-hidden="true" />
            </div>
          )
        })}
        <canvas ref={canvas} className="absolute top-0 left-0 cursor-crosshair" style={{ width: width || "100%", height: layout.height }}
          onMouseMove={(event) => { const i = hit(layout, event.nativeEvent.offsetX, event.nativeEvent.offsetY); if (i !== hover) setHover(i) }}
          onMouseLeave={() => setHover(-1)}
          onClick={(event) => { const i = hit(layout, event.nativeEvent.offsetX, event.nativeEvent.offsetY); if (i >= 0) onSelect(layout.flat[i].name === selected ? null : layout.flat[i].name) }}
          onDoubleClick={(event) => { const i = hit(layout, event.nativeEvent.offsetX, event.nativeEvent.offsetY); if (i >= 0) onOpen(layout.flat[i].name) }} />
        {hovered && (
          <div role="tooltip" className="pointer-events-none absolute z-20 w-max max-w-64 rounded-md bg-foreground px-2.5 py-1.5 text-background shadow-lg"
            style={{
              top: hoverCell.y + layout.size + 8,
              left: Math.min(Math.max(8, hoverCell.x - 20), (width || 800) - 240),
            }}>
            <p className="font-mono text-[11px] font-medium">{hovered.name}</p>
            <p className="text-[10px] opacity-70">{PHASE_LABEL[hovered.phase]} · {imageName(hovered.image, hovered.imageTemplateName)}</p>
            {(hoverTraffic || hoverAsks > 0) && (
              <p className="mt-0.5 font-mono text-[10px] tabular-nums">
                {hoverTraffic ? <span className="opacity-80">{count(hoverTraffic.allowed)}↑ </span> : null}
                {hoverTraffic?.denied ? <span className="text-red-300">{count(hoverTraffic.denied)}✕ </span> : null}
                {hoverAsks > 0 ? <span className="text-amber-300">{hoverAsks} ask</span> : null}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
