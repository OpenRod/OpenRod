import * as React from "react"
import { api } from "@/lib/api"

export function useInventory() {
  const [inventory, setInventory] = React.useState({ sandboxes: [], templates: [], locations: [] })
  const [error, setError] = React.useState(null)
  const [loading, setLoading] = React.useState(true)
  const [revision, refresh] = React.useReducer((value) => value + 1, 0)

  React.useEffect(() => {
    let alive = true
    let timer
    let interval = 5000
    const load = async () => {
      try {
        const next = await api.inventory()
        interval = next.templates.some((record) => record.status === "building") ? 1200 : 5000
        if (alive) { setInventory(next); setError(null) }
      } catch (error) {
        // Cached state remains visible, but must not look live or accept actions.
        if (alive) {
          setError(error.message)
          setInventory((current) => {
            const locations = current.locations.map((location) => ({ ...location, connected: false, error: error.message }))
            const owners = new Map(locations.map((location) => [location.context, location]))
            return { locations, sandboxes: current.sandboxes.map((record) => ({ ...record, location: owners.get(record.location.context) })), templates: current.templates.map((record) => ({ ...record, location: owners.get(record.location.context) })) }
          })
        }
      } finally {
        if (alive) { setLoading(false); timer = setTimeout(load, interval) }
      }
    }
    load()
    return () => { alive = false; clearTimeout(timer) }
  }, [revision])

  return { ...inventory, error, loading, refresh }
}
