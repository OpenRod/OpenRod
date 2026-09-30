import * as React from "react"
import { motion, useMotionTemplate, useMotionValue } from "motion/react"

import { cn } from "@/lib/utils"

// Magic UI spotlight using the console appearance tokens.
export function MagicCard({
  children,
  className,
  gradientSize = 180,
  gradientColor = "rgba(120, 113, 108, 0.10)",
  gradientOpacity = 1,
  gradientFrom = "var(--ink-faint)",
  gradientTo = "var(--border)",
}) {
  const mouseX = useMotionValue(-gradientSize)
  const mouseY = useMotionValue(-gradientSize)
  const park = React.useCallback(() => {
    mouseX.set(-gradientSize)
    mouseY.set(-gradientSize)
  }, [mouseX, mouseY, gradientSize])

  React.useEffect(() => {
    park()
    const onBlur = () => park()
    window.addEventListener("blur", onBlur)
    return () => window.removeEventListener("blur", onBlur)
  }, [park])

  const border = useMotionTemplate`
    linear-gradient(var(--card) 0 0) padding-box,
    radial-gradient(${gradientSize}px circle at ${mouseX}px ${mouseY}px, ${gradientFrom}, ${gradientTo}, var(--border) 100%) border-box
  `
  const spotlight = useMotionTemplate`
    radial-gradient(${gradientSize}px circle at ${mouseX}px ${mouseY}px, ${gradientColor}, transparent 100%)
  `

  return (
    <motion.div
      className={cn("group relative isolate overflow-hidden rounded-[inherit] border border-transparent", className)}
      onPointerMove={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect()
        mouseX.set(event.clientX - bounds.left)
        mouseY.set(event.clientY - bounds.top)
      }}
      onPointerLeave={park}
      style={{ background: border }}
    >
      <div className="absolute inset-px z-20 rounded-[inherit] bg-card" />
      <motion.div
        aria-hidden="true"
        className="pointer-events-none absolute inset-px z-30 rounded-[inherit] opacity-0 transition-opacity duration-300 group-hover:opacity-100"
        style={{ background: spotlight, opacity: gradientOpacity }}
      />
      <div className="relative z-40">{children}</div>
    </motion.div>
  )
}
