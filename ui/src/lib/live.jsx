import * as React from "react"
import { activityKey as eventKey } from "@/lib/activity-inventory"
import { api } from "@/lib/api"

// One live picture of the gateway for every page: sandboxes and the audit
// trail arrive over one event stream; gateway facts are
// re-read when the stream says they changed (and on a slow timer, in case it didn't).
const LiveContext = React.createContext(null)
const MAX_EVENTS = 2000


export function LiveProvider({ children }) {
  const [sandboxes, setSandboxes] = React.useState(null)
  const [overview, setOverview] = React.useState(null)
  const [events, setEvents] = React.useState([])
  const [connection, setConnection] = React.useState("connecting")
  const [collection, setCollection] = React.useState(null)
  const [historyError, setHistoryError] = React.useState(null)
  const seen = React.useRef(new Set())

  const addEvents = React.useCallback((incoming) => {
    const fresh = incoming.filter((e) => {
      const key = eventKey(e)
      if (seen.current.has(key)) return false
      seen.current.add(key)
      return true
    })
    if (!fresh.length) return
    setEvents((current) => {
      const next = [...fresh, ...current].sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""))
      if (next.length <= MAX_EVENTS) return next
      for (const dropped of next.slice(MAX_EVENTS)) seen.current.delete(eventKey(dropped))
      return next.slice(0, MAX_EVENTS)
    })
  }, [])

  const loadOverview = React.useCallback(async () => {
    try { setOverview(await api.overview()) } catch (error) { setOverview((current) => current ?? { error: error.message }) }
  }, [])

  const loadHistory = React.useCallback(async () => {
    try { const result = await api.activity({ limit: 500 }); addEvents(result.events); setCollection(result.coverage); setHistoryError(null) } catch (error) { setHistoryError(error.message) }
  }, [addEvents])

  React.useEffect(() => {
    loadOverview(); loadHistory()
    const source = new EventSource("/api/os/stream")
    source.onopen = () => { setConnection("live"); loadHistory() }
    source.onerror = () => setConnection("reconnecting")
    source.addEventListener("sandboxes", (e) => { setConnection("live"); setSandboxes(JSON.parse(e.data)) })
    source.addEventListener("log", (e) => addEvents([JSON.parse(e.data)]))
    source.addEventListener("collection", (e) => setCollection(JSON.parse(e.data)))
    source.addEventListener("gateway-health", () => setConnection("live"))
    source.addEventListener("gateway-error", () => setConnection("gateway-down"))
    const slow = setInterval(() => { loadOverview() }, 15000)
    return () => { source.close(); clearInterval(slow) }
  }, [addEvents, loadHistory, loadOverview])

  const value = React.useMemo(() => ({
    sandboxes: sandboxes ?? overview?.sandboxes ?? null,
    overview, events, connection, collection, historyError,
    refresh: () => { loadOverview(); loadHistory() },
  }), [sandboxes, overview, events, connection, collection, historyError, loadOverview, loadHistory])

  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>
}

export function useLive() {
  const value = React.useContext(LiveContext)
  if (!value) throw new Error("useLive outside LiveProvider")
  return value
}
