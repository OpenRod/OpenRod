import * as React from 'react'
import { createApi } from '@/lib/api'
import { useCompute } from '@/lib/compute'
import { localCloudRequest } from '@/lib/local-cloud'
import { mergeLocationInventories } from '@/lib/location-inventory'
import { analytics } from '@/lib/analytics'

export function useInventory() {
  const compute = useCompute()
  const localViewer = Boolean(compute?.localViewer)
  const cloudEnabled = localViewer && compute.connected
  const scope = `${localViewer}:${cloudEnabled ? compute.user?.uid : ''}`
  const [snapshot, setSnapshot] = React.useState(null)
  const [revision, refresh] = React.useReducer(value => value + 1, 0)
  React.useEffect(() => {
    let alive = true, timer
    const controller = new AbortController()
    const local = createApi('local', controller.signal)
    let previous = null
    const load = async () => {
      const results = await Promise.allSettled([
        local.inventory(),
        ...(cloudEnabled ? [localCloudRequest('inventory', undefined, { signal: controller.signal })] : []),
      ])
      if (!alive) return
      const sources = [], errors = []
      for (let i = 0; i < results.length; i++) {
        const target = i === 0 ? 'local' : 'cloud', cloud = i !== 0 || !localViewer
        const result = results[i]
        if (result.status === 'fulfilled') {
          sources.push({ target, cloud, inventory: result.value })
          if (result.value.machine?.error) errors.push(result.value.machine.error)
        } else {
          errors.push(`${cloud ? 'Cloud' : 'Local'} inventory unavailable: ${result.reason.message}`)
          const cached = previous?.filter(source => source.target === target)[0]?.inventory
          if (cached) {
            const locations = cached.locations.map(location => ({ ...location, connected: false, error: result.reason.message }))
            sources.push({ target, cloud, inventory: { ...cached, locations } })
          }
        }
      }
      previous = sources
      const inventory = mergeLocationInventories(sources)
      analytics.observeTemplates(inventory.templates)
      setSnapshot({ scope, inventory, error: errors.join('; ') || null })
      timer = setTimeout(load, inventory.templates.some(record => record.status === 'building') ? 1200 : 5000)
    }
    load()
    return () => { alive = false; controller.abort(); clearTimeout(timer) }
  }, [scope, revision, localViewer, cloudEnabled])
  const current = snapshot?.scope === scope ? snapshot : null
  return { ...(current?.inventory ?? { sandboxes: [], templates: [], locations: [] }), error: current?.error ?? null, loading: !current, refresh }
}
