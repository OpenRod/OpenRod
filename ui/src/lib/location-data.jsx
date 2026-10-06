import * as React from 'react'
import { createApi } from '@/lib/api'
import { useApi, useCompute } from '@/lib/compute'
import { useInventory } from '@/lib/inventory'
import { locationLabel } from '@/lib/locations'
import { Button } from '@/components/ui/button'
import { readLocationData, unreadSources } from './location-data-reader.js'

const readings = new Map()
export function useLocationData(methods) {
  const base = useApi()
  const compute = useCompute()
  const inventory = useInventory()
  const methodKey = methods.join(',')
  const scope = `${base.owner ?? ''}:${compute?.user?.uid ?? ''}:${methodKey}`
  const signature = JSON.stringify(inventory.locations.map(({id, context, connected}) => [id, context, connected]))
  const currentLocations = React.useRef(inventory.locations)
  currentLocations.current = inventory.locations
  const [snapshot, setSnapshot] = React.useState(null)
  const [loading, setLoading] = React.useState(true)
  const generation = React.useRef(0)
  const apiFor = React.useCallback(location => createApi(compute?.localViewer ? location.target : base.target, base.signal, location.context, base.owner), [base, compute?.localViewer])
  const refresh = React.useCallback(async () => {
    const ticket = ++generation.current
    setLoading(true)
    const sources = await readLocationData(currentLocations.current, methodKey.split(',').filter(Boolean), apiFor, readings.get(scope))
    if (ticket !== generation.current || base.signal?.aborted) return
    readings.set(scope, sources)
    setSnapshot({scope, sources}); setLoading(false)
    return sources
  }, [apiFor, methodKey, scope, base.signal])
  React.useEffect(() => {
    if (inventory.loading) return
    refresh()
    const timer = setInterval(refresh, 15000)
    return () => { generation.current++; clearInterval(timer) }
  }, [refresh, signature, inventory.loading])
  const sources = React.useMemo(() => snapshot?.scope === scope ? snapshot.sources.map(source => ({...source, location: {...source.location, connected: source.location.connected && currentLocations.current.some(location => location.id === source.location.id && location.connected)}})) : [], [snapshot, scope, signature])
  const status = React.useMemo(() => unreadSources(sources, methodKey.split(',').filter(Boolean)), [sources, methodKey])
  return { sources, status, loading: inventory.loading || loading, refresh, apiFor, locations: inventory.locations, inventory, error: sources.filter(source=>source.error).map(source=>`${source.location.label}: ${source.error}`).join('; ') }
}

// Names each source a combined page could not read, without blocking the rest.
export function SourceStatus({ model, what, offline = true }) {
  const { failed, offline: missing } = model.status
  const names = missing.map(source => locationLabel(source.location))
  return <>
    {failed.map(source => <div key={source.location.id ?? source.location.context} role="alert" className="flex items-center gap-3 border-b border-border px-4 py-2 text-xs text-red-600 sm:px-6"><span className="min-w-0">{locationLabel(source.location)}: {source.error}</span><Button variant="outline" size="sm" className="shrink-0" onClick={model.refresh}>Retry</Button></div>)}
    {offline && names.length > 0 && <p role="status" className="border-b border-border px-4 py-1.5 text-[11px] text-muted-foreground sm:px-6">{names.join(', ')} {names.length === 1 ? 'is' : 'are'} offline. Reconnect to see {names.length === 1 ? 'its' : 'their'} {what}.</p>}
  </>
}
