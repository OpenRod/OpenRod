import * as React from "react"
import { motion, useReducedMotion } from "motion/react"

// Monotone cubic interpolation (Fritsch–Carlson), as on the Boxes growth
// chart: a count per minute never dips below zero between two readings.
export function smoothPath(pts) {
  if (pts.length < 2) return pts.length ? `M${pts[0][0]} ${pts[0][1]}` : ""
  const n = pts.length
  const dx = [], slope = []
  for (let i = 0; i < n - 1; i++) {
    dx[i] = pts[i + 1][0] - pts[i][0]
    slope[i] = (pts[i + 1][1] - pts[i][1]) / (dx[i] || 1)
  }
  const m = [slope[0]]
  for (let i = 1; i < n - 1; i++) m[i] = slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2
  m[n - 1] = slope[n - 2]
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) { m[i] = 0; m[i + 1] = 0; continue }
    const a = m[i] / slope[i], b = m[i + 1] / slope[i]
    const h = Math.hypot(a, b)
    if (h > 3) { m[i] = (3 * a / h) * slope[i]; m[i + 1] = (3 * b / h) * slope[i] }
  }
  let d = `M${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}`
  for (let i = 0; i < n - 1; i++) {
    const third = dx[i] / 3
    d += ` C${(pts[i][0] + third).toFixed(2)} ${(pts[i][1] + m[i] * third).toFixed(2)}`
      + ` ${(pts[i + 1][0] - third).toFixed(2)} ${(pts[i + 1][1] - m[i + 1] * third).toFixed(2)}`
      + ` ${pts[i + 1][0].toFixed(2)} ${pts[i + 1][1].toFixed(2)}`
  }
  return d
}

// Connection decisions per minute over a window. One line for everything the
// proxy decided; a denial is marked where it happened rather than drawn as a
// second series, because denials are events to find, not a trend to read.
export function bucketEgress(events, minutes, now) {
  const start = now - minutes * 60000
  const buckets = Array.from({ length: minutes }, (_, i) => ({ at: start + (i + 1) * 60000, allowed: 0, denied: 0 }))
  for (const event of events) {
    if (event.kind !== "audit" || !event.verdict || !event.at) continue
    const t = Date.parse(event.at)
    if (t <= start || t > now) continue
    const index = Math.min(minutes - 1, Math.floor((t - start) / 60000))
    buckets[index][event.verdict] += 1
  }
  return buckets
}

const clock = (at) => new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })

export function EgressChart({ points, height = 34, title, action }) {
  const box = React.useRef(null)
  const gradient = React.useId()
  const reduceMotion = useReducedMotion()
  const [width, setWidth] = React.useState(280)
  const [hover, setHover] = React.useState(null)
  React.useLayoutEffect(() => {
    const element = box.current
    if (!element) return
    const measure = () => setWidth(element.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const pad = Math.max(4, Math.round(height * 0.18))
  const totals = points.map((p) => p.allowed + p.denied)
  const peak = Math.max(1, ...totals)
  const x = (i) => (points.length < 2 ? width - 12 : (i / (points.length - 1)) * (width - 12)) + 6
  const y = (v) => height - pad - (v / peak) * (height - pad * 2)
  const coords = totals.map((v, i) => [x(i), y(v)])
  const line = smoothPath(coords)
  const area = `${line} L${x(points.length - 1).toFixed(2)} ${height} L${x(0).toFixed(2)} ${height} Z`
  const active = hover === null ? null : points[hover]
  const sum = (key) => points.reduce((n, p) => n + p[key], 0)

  return (
    <div className="relative w-full"
      onMouseLeave={() => setHover(null)}
      onMouseMove={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect()
        const ratio = (event.clientX - bounds.left) / Math.max(1, bounds.width)
        setHover(Math.min(points.length - 1, Math.max(0, Math.round(ratio * (points.length - 1)))))
      }}>
      <div className="flex items-center gap-2">
        <h2 className="min-w-0 truncate text-[10px] font-bold tracking-widest text-faint uppercase">
          {active ? (
            <span className="font-mono normal-case tracking-normal text-muted-foreground">
              {clock(active.at)} · {active.allowed} allowed{active.denied ? <span className="text-red-600"> · {active.denied} denied</span> : null}
            </span>
          ) : title}
        </h2>
        <span className="ml-auto shrink-0">{action}</span>
      </div>
      <div ref={box} className="w-full">
        <svg width={width} height={height} role="img"
          aria-label={`${sum("allowed")} allowed and ${sum("denied")} denied connections over ${points.length} minutes`}>
          <defs>
            <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--ink)" stopOpacity="0.1" />
              <stop offset="100%" stopColor="var(--ink)" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={area} fill={`url(#${gradient})`} />
          <motion.path d={line} fill="none" stroke="var(--ink)" strokeWidth="1.5"
            strokeLinejoin="round" strokeLinecap="round" opacity="0.72"
            initial={reduceMotion ? false : { pathLength: 0 }} animate={{ pathLength: 1 }}
            transition={{ duration: 0.9, ease: "easeOut" }} />
          {points.map((p, i) => (p.denied ? (
            <circle key={p.at} cx={x(i)} cy={height - 2} r="1.75" fill="var(--status-error)" opacity={hover === i ? 1 : 0.75} />
          ) : null))}
          {active && (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1="0" y2={height} stroke="var(--ink)" strokeWidth="1" strokeDasharray="2 3" opacity="0.25" />
              <circle cx={x(hover)} cy={y(totals[hover])} r="3" fill="var(--surface)" stroke="var(--ink)" strokeWidth="1.5" />
            </g>
          )}
        </svg>
      </div>
    </div>
  )
}
