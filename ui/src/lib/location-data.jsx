import * as React from 'react'
import { createApi } from '@/lib/api'
import { useApi, useCompute } from '@/lib/compute'
import { useInventory } from '@/lib/inventory'
import { readLocationData } from './location-data-reader.js'

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
  const apiFor = React.useCallback(location => {
    const target = compute?.localViewer ? location.target : base.target
    return createApi(target, base.signal, location.context, target === 'cloud' ? compute?.status?.owner ?? base.owner : base.owner)
  }, [base, compute?.localViewer, compute?.status?.owner])
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
    const changed = () => refresh()
    window.addEventListener('openrod-resources-changed', changed)
    return () => { generation.current++; clearInterval(timer); window.removeEventListener('openrod-resources-changed', changed) }
  }, [refresh, signature, inventory.loading])
  const sources = React.useMemo(() => snapshot?.scope === scope ? snapshot.sources.map(source => ({...source, location: {...source.location, connected: source.location.connected && currentLocations.current.some(location => location.id === source.location.id && location.connected)}})) : [], [snapshot, scope, signature])
  return { sources, loading: inventory.loading || loading, refresh, apiFor, locations: inventory.locations, inventory, error: sources.filter(source=>source.error).map(source=>`${source.location.label}: ${source.error}`).join('; ') }
}
