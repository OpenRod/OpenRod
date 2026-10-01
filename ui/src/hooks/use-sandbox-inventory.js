import * as React from 'react'
import {createApi} from '@/lib/api'
import {localCloudRequest} from '@/lib/local-cloud'
import {mergeSandboxInventories} from '@/lib/sandbox-inventory'

// The selected gateway retains its live stream. Read the other inventory
// separately; listing an existing cloud VM must never allocate a new one.
export function useSandboxInventory(live, compute) {
  const selected = compute?.target ?? 'local'
  const other = selected === 'local' ? 'cloud' : 'local'
  const enabled = compute?.localViewer && !live.demo && (other === 'local' || compute.connected)
  const scope = `${other}:${compute?.user?.uid ?? ''}`
  const [secondary, setSecondary] = React.useState(null)
  const refreshOther = React.useRef(() => {})
  React.useEffect(() => {
    if (!enabled) return
    let active = true
    const controller = new AbortController(), api = createApi(other, controller.signal)
    const load = async () => {
      try {
        const overview = other === 'cloud' ? await localCloudRequest('inventory', undefined, {signal:controller.signal}) : await api.overview()
        if (active) setSecondary({scope,overview,error:overview.error ?? overview.machine?.error ?? null})
      } catch(error) {
        if(active && error.name !== 'AbortError') setSecondary(current => ({scope,overview:current?.scope === scope ? current.overview : null,error:error.message}))
      }
    }
    refreshOther.current = load
    load()
    const timer = setInterval(load,15000)
    return () => {active=false;controller.abort();clearInterval(timer);refreshOther.current=()=>{}}
  },[enabled,other,scope])
  const current = enabled && secondary?.scope === scope ? secondary : null
  const sources = {[selected]:live.sandboxes,[other]:current?.overview?.sandboxes}
  return {
    sandboxes:mergeSandboxInventories(sources),
    error:current?.error ? `${other === 'cloud' ? 'Cloud' : 'Local'} inventory unavailable: ${current.error}` : null,
    refresh:() => {live.refresh();refreshOther.current()},
  }
}
