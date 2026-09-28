import * as React from "react"
import { toast } from "sonner"
import { api } from "@/lib/api"

// One live picture of the gateway for every page: sandboxes and the audit
// trail arrive over one event stream; approvals and gateway facts are
// re-read when the stream says they changed (and on a slow timer, in case it didn't).
const LiveContext = React.createContext(null)
const MAX_EVENTS = 2000

const eventKey = (e) => `${e.sandbox}|${e.at}|${e.message}`

export function LiveProvider({ children }) {
  const [sandboxes, setSandboxes] = React.useState(null)
  const [overview, setOverview] = React.useState(null)
  const [approvals, setApprovals] = React.useState({ pending: [], decided: [], loaded: false })
  const [events, setEvents] = React.useState([])
  const [connection, setConnection] = React.useState("connecting")
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

  const pendingIds = React.useRef(null)
  const loadApprovals = React.useCallback(async () => {
    try {
      const next = await api.approvals()
      // Announce requests that appeared since the last reading, not on first load.
      if (pendingIds.current) {
        for (const chunk of next.pending) {
          if (!pendingIds.current.has(chunk.id)) {
            const where = chunk.endpoints[0] ? `${chunk.endpoints[0].host}${chunk.endpoints[0].port ? `:${chunk.endpoints[0].port}` : ""}` : chunk.ruleName
            toast(`${chunk.sandbox} wants to reach ${where}`, { description: chunk.binary ?? undefined, action: { label: "Review", onClick: () => { try { sessionStorage.setItem("approvals-scope", chunk.sandbox) } catch { /* optional */ } window.location.hash = "approvals" } } })
          }
        }
      }
      pendingIds.current = new Set(next.pending.map((c) => c.id))
      setApprovals({ ...next, loaded: true })
    } catch { setApprovals((current) => ({ ...current, loaded: true })) }
  }, [])

  const loadHistory = React.useCallback(async () => {
    try { addEvents(await api.activity()) } catch { /* The stream still delivers new events. */ }
  }, [addEvents])

  React.useEffect(() => {
    loadOverview(); loadApprovals(); loadHistory()
    const source = new EventSource("/api/os/stream")
    source.onopen = () => setConnection("live")
    source.onerror = () => setConnection("reconnecting")
    source.addEventListener("sandboxes", (e) => { setConnection("live"); setSandboxes(JSON.parse(e.data)) })
    source.addEventListener("log", (e) => addEvents([JSON.parse(e.data)]))
    source.addEventListener("draft", () => loadApprovals())
    source.addEventListener("gateway-error", () => setConnection("gateway-down"))
    const slow = setInterval(() => { loadApprovals(); loadOverview() }, 15000)
    return () => { source.close(); clearInterval(slow) }
  }, [addEvents, loadApprovals, loadHistory, loadOverview])

  const value = React.useMemo(() => ({
    sandboxes: sandboxes ?? overview?.sandboxes ?? null,
    overview, approvals, events, connection,
    refresh: () => { loadOverview(); loadApprovals(); loadHistory() },
    refreshApprovals: loadApprovals,
  }), [sandboxes, overview, approvals, events, connection, loadOverview, loadApprovals, loadHistory])

  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>
}

export function useLive() {
  const value = React.useContext(LiveContext)
  if (!value) throw new Error("useLive outside LiveProvider")
  return value
}
