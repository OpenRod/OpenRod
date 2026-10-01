import * as React from "react"
import { motion, useReducedMotion } from "motion/react"
import { smoothPath } from "@/components/egress-chart"

const DAY = 86400000

// Boxes in the fleet at the end of each day, rebuilt from creation times. The
// inventory only lists boxes that still exist, so a deleted box never counts.
export function bucketBoxes(sandboxes, days, now) {
  const created = sandboxes.map((sandbox) => Date.parse(sandbox.createdAt)).filter(Number.isFinite).sort((a, b) => a - b)
  const undated = sandboxes.length - created.length
  const points = []
  let index = 0
  for (let i = days - 1; i >= 0; i--) {
    const at = now - i * DAY
    while (index < created.length && created[index] <= at) index++
    points.push({ at, count: index + undated })
  }
  return points
}

const day = (at) => new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" })

export function BoxCountChart({ points, height = 34, title }) {
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
  const counts = points.map((p) => p.count)
  const peak = Math.max(1, ...counts)
  const x = (i) => (points.length < 2 ? width - 12 : (i / (points.length - 1)) * (width - 12)) + 6
  const y = (v) => height - pad - (v / peak) * (height - pad * 2)
  const line = smoothPath(counts.map((v, i) => [x(i), y(v)]))
  const area = `${line} L${x(points.length - 1).toFixed(2)} ${height} L${x(0).toFixed(2)} ${height} Z`
  const active = hover === null ? null : points[hover]
  const first = counts[0] ?? 0, last = counts[counts.length - 1] ?? 0

  return (
    <div className="relative w-full"
      onMouseLeave={() => setHover(null)}
      onMouseMove={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect()
        const ratio = (event.clientX - bounds.left) / Math.max(1, bounds.width)
        setHover(Math.min(points.length - 1, Math.max(0, Math.round(ratio * (points.length - 1)))))
      }}>
      <h2 className="min-w-0 truncate text-[10px] font-bold tracking-widest text-faint uppercase">
        {active ? (
          <span className="font-mono normal-case tracking-normal text-muted-foreground">
            {day(active.at)} · {active.count.toLocaleString("en-US")} {active.count === 1 ? "box" : "boxes"}
          </span>
        ) : title}
      </h2>
      <div ref={box} className="w-full">
        <svg width={width} height={height} role="img" aria-label={`${first} boxes ${points.length} days ago, ${last} now`}>
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
          {active && (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1="0" y2={height} stroke="var(--ink)" strokeWidth="1" strokeDasharray="2 3" opacity="0.25" />
              <circle cx={x(hover)} cy={y(counts[hover])} r="3" fill="var(--surface)" stroke="var(--ink)" strokeWidth="1.5" />
            </g>
          )}
        </svg>
      </div>
    </div>
  )
}
