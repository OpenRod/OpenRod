import * as React from "react"

import { demoEvent, demoFleet, demoHistory } from "@/lib/fleet"

// Development only: `?fleet=10000` swaps the live list for a synthetic fleet so
// the page can be judged at the size it is designed for.
const DEMO_SIZE = import.meta.env.DEV ? Number(new URLSearchParams(window.location.search).get("fleet")) || 0 : 0

export function useDemoFleet(live) {
  const fleet = React.useMemo(() => (DEMO_SIZE ? demoFleet(DEMO_SIZE) : null), [])
  const [events, setEvents] = React.useState(() => (fleet ? demoHistory(fleet) : []))
  React.useEffect(() => {
    if (!fleet) return
    const running = fleet.filter((s) => s.phase === "ready")
    const timer = setInterval(() => {
      const burst = Array.from({ length: 1 + Math.floor(Math.random() * 6) }, () => demoEvent(running))
      setEvents((current) => [...burst, ...current].slice(0, 2000))
    }, 450)
    return () => clearInterval(timer)
  }, [fleet])
  const pending = React.useMemo(() => (fleet ? fleet.filter((_, i) => i % 97 === 3).map((s, i) => ({ id: `demo-${i}`, sandbox: s.name, endpoints: [{ host: "pastebin.com", port: 443 }] })) : []), [fleet])
  if (!fleet) return live
  return { ...live, sandboxes: fleet, events, approvals: { ...live.approvals, pending }, demo: true }
}
