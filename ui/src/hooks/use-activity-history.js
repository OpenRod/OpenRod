import * as React from 'react'
import { api } from '@/lib/api'

export function useActivityHistory(options, { paused, demo }) {
  const pausedRef = React.useRef(paused)
  pausedRef.current = paused
  const query = JSON.stringify(options)
  const [result, setResult] = React.useState({ events: [], total: 0, nextOffset: null })
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
    setResult({ events: [], total: 0, nextOffset: null })
    fetchPage()
    const timer = setInterval(() => { if (!pausedRef.current) fetchPage(true) }, 5000)
    return () => { alive = false; clearInterval(timer) }
  }, [query, demo, revision])
  const more = async () => {
    const version = generation.current
    const ticket = ++request.current
    setLoading(true)
    try {
      const page = await api.activity({ ...JSON.parse(query), snapshot: result.snapshot, offset: result.nextOffset, now: result.now })
      if (version === generation.current && ticket === request.current) { setResult((old) => ({ ...page, events: [...old.events, ...page.events] })); setError(null) }
    } catch (e) { if (version === generation.current) setError(e.message) }
    finally { if (version === generation.current) setLoading(false) }
  }
  return { ...result, loading, error, more, refresh }
}
