import * as React from 'react'
import { useApi } from '@/lib/location-context'

export function useActivityHistory(options, { paused, demo, activityRevision }) {
  const api = useApi()
  const pausedRef = React.useRef(paused)
  pausedRef.current = paused
  const query = JSON.stringify(options)
  const [result, setResult] = React.useState({ events: [], total: 0, nextOffset: null })
  const [page, setPage] = React.useState(0)
  const [error, setError] = React.useState(null)
  const [loading, setLoading] = React.useState(false)
  const [revision, refresh] = React.useReducer((n) => n + 1, 0)
  const generation = React.useRef(0)
  const request = React.useRef(0)
  React.useEffect(() => {
    const version = ++generation.current
    if (demo) return
    let alive = true
    const fetchPage = async (automatic = false) => {
      const ticket = ++request.current
      setLoading(true)
      try {
        const next = await api.activity(JSON.parse(query))
        if (alive && generation.current === version && ticket === request.current && (!automatic || !pausedRef.current)) { setResult(next); setError(null) }
      } catch (e) { if (alive && ticket === request.current) setError(e.message) }
      finally { if (alive && ticket === request.current) setLoading(false) }
    }
    // Query changes always run, including while the view is paused.
    setPage(0)
    setResult({ events: [], total: 0, nextOffset: null })
    fetchPage()
    const timer = setInterval(() => { if (!pausedRef.current) fetchPage(true) }, 5000)
    return () => { alive = false; clearInterval(timer) }
  }, [query, demo, revision, activityRevision, api])
  const goToPage = async (nextPage) => {
    if (loading || nextPage < 0 || nextPage >= Math.ceil(result.total / options.limit)) return
    const version = generation.current
    const ticket = ++request.current
    setLoading(true)
    try {
      const next = await api.activity({ ...JSON.parse(query), snapshot: result.snapshot, offset: nextPage * options.limit, now: result.now })
      if (version === generation.current && ticket === request.current) { setResult(next); setPage(nextPage); setError(null) }
    } catch (e) { if (version === generation.current && ticket === request.current) setError(e.message) }
    finally { if (version === generation.current && ticket === request.current) setLoading(false) }
  }
  return { ...result, loading, error, page, goToPage, refresh }
}
