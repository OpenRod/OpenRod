import * as React from 'react'
import { Cloud, Laptop } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { createApi } from '@/lib/api'
import { useApi, useCompute } from '@/lib/compute'
import { copyLocalSandbox, localCloudRequest, waitForCloudReady } from '@/lib/local-cloud'
import { LOCAL_ORIGIN, localHandoffUrl, isLocalHandoffMessage } from '@/lib/cloud-transfer'

export function ContinueInCloud({ name, sandbox }) {
  const api = useApi()
  const compute = useCompute()
  const [stage, setStage] = React.useState(null)
  async function copy() {
    setStage('signin')
    try {
      await compute.connect()
      setStage('prepare')
      await waitForCloudReady(() => localCloudRequest('machine'), { signal: api.signal })
      setStage('transfer')
      const result = await copyLocalSandbox(api, createApi('cloud', api.signal), name)
      if (api.signal?.aborted) return
      toast.success('Workspace ready in cloud', { description: result.warning || 'Reconnect your agent credentials to continue.' })
      try { sessionStorage.setItem('gateway-box', result.name) } catch {}
      compute.selectTarget('cloud')
    } catch (error) { if (error.name !== 'AbortError') toast.error('Couldn’t continue in cloud', { description: error.message }) }
    finally { setStage(null) }
  }
  if (sandbox?.phase !== 'ready') return null
  return <div className="space-y-1.5">
    <Button variant="outline" size="sm" className="w-full justify-start text-xs" disabled={Boolean(stage)} onClick={copy}>
      {stage ? <Spinner className="size-3.5" /> : <Cloud className="size-3.5" aria-hidden="true" />}
      {stage === 'signin' ? 'Sign in to cloud…' : stage === 'prepare' ? 'Preparing cloud machine…' : stage === 'transfer' ? 'Copying and rebuilding…' : 'Continue in cloud'}
    </Button>
    <p className="text-[11px] leading-relaxed text-muted-foreground">Copies workspace files and rebuilds saved templates. Your local source stays available. Credential files are excluded; reconnect agents in cloud.</p>
  </div>
}

export function ContinueLocally({ name, sandbox }) {
  const api = useApi()
  const [stage, setStage] = React.useState(null)
  const handoff = React.useRef(null)
  React.useEffect(() => {
    let active = true
    const receive = async (event) => {
      const current = handoff.current
      if (!current) return
      if (isLocalHandoffMessage(event, current.popup, current.nonce, 'openrod-local-result') && current.accepted) {
        if (active) {
          if (typeof event.data.error === 'string') toast.error('Couldn’t continue locally', { description: event.data.error })
          else if (typeof event.data.name === 'string') toast.success('Workspace ready locally', { description: event.data.warning || current.warning || 'Reconnect your agent credentials locally to continue.' })
          else return
          setStage(null)
        }
        handoff.current = null
        return
      }
      if (current.accepted || !isLocalHandoffMessage(event, current.popup, current.nonce, 'openrod-local-ready')) return
      current.accepted = true
      setStage('transfer')
      try {
        const exported = await api.cloudExport(current.name)
        current.warning = exported.warning
        current.popup.postMessage({ type: 'openrod-local-bundle', nonce: current.nonce, bundle: exported.bundle, warning: exported.warning }, LOCAL_ORIGIN)
      } catch (error) {
        current.popup.postMessage({ type: 'openrod-local-bundle', nonce: current.nonce, error: error.message }, LOCAL_ORIGIN)
        if (handoff.current === current) handoff.current = null
        if (active) { setStage(null); toast.error('Couldn’t continue locally', { description: error.message }) }
      }
    }
    window.addEventListener('message', receive)
    const timer = setInterval(() => {
      const current = handoff.current
      if (current && (current.popup.closed || Date.now() > current.expires)) {
        handoff.current = null
        setStage(null)
        if (!current.popup.closed) toast.error('Local transfer timed out. Try again.')
      }
    }, 1000)
    return () => { active = false; window.removeEventListener('message', receive); clearInterval(timer); handoff.current = null }
  }, [name])

  if (sandbox?.phase !== 'ready') return null
  return (
    <div className="space-y-1.5">
      <Button variant="outline" size="sm" className="w-full justify-start text-xs" disabled={Boolean(stage)} onClick={() => {
        const nonce = crypto.randomUUID()
        const popup = window.open(localHandoffUrl(nonce), '_blank')
        if (!popup) { toast.error('Allow popups to continue locally.'); return }
        handoff.current = { popup, nonce, name, accepted: false, expires: Date.now() + 40 * 60_000 }
        setStage('connect')
      }}>
        {stage ? <Spinner className="size-3.5" /> : <Laptop className="size-3.5" aria-hidden="true" />}
        {stage === 'connect' ? 'Connecting to local OpenRod…' : stage === 'transfer' ? 'Copying and rebuilding…' : 'Continue locally'}
      </Button>
      <p className="text-[11px] leading-relaxed text-muted-foreground">Open OpenRod on this computer first. Copies files and rebuilds saved templates; reconnect agents locally.</p>
    </div>
  )
}
