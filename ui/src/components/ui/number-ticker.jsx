import * as React from "react"
import { useInView, useMotionValue, useSpring, useReducedMotion } from "motion/react"

import { cn } from "@/lib/utils"

// Magic UI's Number Ticker, converted to JSX and taught to respect reduced
// motion: a fleet count that animates is charm, a fleet count that animates
// for someone who asked it not to is a bug.
export function NumberTicker({
  value,
  startValue = 0,
  direction = "up",
  delay = 0,
  className,
  decimalPlaces = 0,
  ...props
}) {
  const ref = React.useRef(null)
  const reduceMotion = useReducedMotion()
  const motionValue = useMotionValue(direction === "down" ? value : startValue)
  const springValue = useSpring(motionValue, { damping: 60, stiffness: 100 })
  const isInView = useInView(ref, { once: true, margin: "0px" })
  const format = React.useCallback(
    (input) =>
      Intl.NumberFormat("en-US", {
        minimumFractionDigits: decimalPlaces,
        maximumFractionDigits: decimalPlaces,
      }).format(Number(input.toFixed(decimalPlaces))),
    [decimalPlaces],
  )

  React.useEffect(() => {
    if (!isInView) return
    const timer = setTimeout(() => motionValue.set(direction === "down" ? startValue : value), delay * 1000)
    return () => clearTimeout(timer)
  }, [motionValue, isInView, delay, value, direction, startValue])

  React.useEffect(
    () => springValue.on("change", (latest) => {
      if (ref.current && !reduceMotion) ref.current.textContent = format(latest)
    }),
    [springValue, format, reduceMotion],
  )

  React.useEffect(() => {
    if (ref.current && reduceMotion) ref.current.textContent = format(value)
  }, [reduceMotion, value, format])

  return (
    <span ref={ref} className={cn("inline-block tabular-nums", className)} {...props}>
      {reduceMotion ? format(value) : startValue}
    </span>
  )
}
