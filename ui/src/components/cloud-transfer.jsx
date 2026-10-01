import * as React from 'react'
import { Cloud, Info, Laptop } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useApi, useLocation } from '@/lib/location-context'
import { CLOUD_ORIGIN, LOCAL_ORIGIN, cloudHandoffUrl, localHandoffUrl, isCloudReadyMessage, isLocalHandoffMessage } from '@/lib/cloud-transfer'

export function ContinueInCloud({ name, sandbox }) {
  const api = useApi()
  const location = useLocation()
  const [stage, setStage] = React.useState(null)
  const handoff = React.useRef(null)
  React.useEffect(() => {
    let active = true
    const receive = async (event) => {
      const current = handoff.current
      if (!current || current.accepted || !isCloudReadyMessage(event, current.popup, current.nonce)) return
      current.accepted = true
      setStage('transfer')
      try {
        const result = await api.cloudTransfer(current.name, event.data.ticket)
        current.popup.postMessage({ type: 'openrod-cloud-result', nonce: current.nonce, name: result.name, warning: result.warning }, CLOUD_ORIGIN)
        if (active) toast.success('Workspace ready in cloud', { description: result.warning || 'Reconnect your agent credentials in cloud to continue.' })
      } catch (error) {
        current.popup.postMessage({ type: 'openrod-cloud-result', nonce: current.nonce, error: error.message }, CLOUD_ORIGIN)
        if (active) toast.error('Couldn’t continue in cloud', { description: error.message })
      } finally {
        if (handoff.current === current) handoff.current = null
        if (active) setStage(null)
      }
    }
    window.addEventListener('message', receive)
    const timer = setInterval(() => {
      const current = handoff.current
      if (current && !current.accepted && (current.popup.closed || Date.now() > current.expires)) {
        handoff.current = null
        setStage(null)
        if (!current.popup.closed) toast.error('Cloud sign-in timed out. Try again.')
      }
    }, 1000)
    return () => { active = false; window.removeEventListener('message', receive); clearInterval(timer); handoff.current = null }
  }, [name, api])

  if (sandbox?.phase !== 'ready') return null
  return (
    <div className="flex items-center gap-1">
      <Button variant="outline" size="sm" className="flex-1 justify-start text-xs" disabled={Boolean(stage) || location?.connected === false} onClick={() => {
        const nonce = crypto.randomUUID()
        // The opener is required for the origin-checked one-use ticket exchange.
        const popup = window.open(cloudHandoffUrl(window.location.origin, nonce), '_blank')
        if (!popup) { toast.error('Allow popups to continue in cloud.'); return }
        handoff.current = { popup, nonce, name, accepted: false, expires: Date.now() + 15 * 60_000 }
        setStage('signin')
      }}>
        {stage ? <Spinner className="size-3.5" /> : <Cloud className="size-3.5" aria-hidden="true" />}
        {stage === 'signin' ? 'Sign in to cloud…' : stage === 'transfer' ? 'Copying and rebuilding…' : 'Continue in cloud'}
      </Button>
      <TooltipProvider delay={200}>
        <Tooltip>
          <TooltipTrigger render={<Button type="button" variant="ghost" size="icon-sm" aria-label="What this does" className="text-muted-foreground" />}>
            <Info className="size-3.5" aria-hidden="true" />
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-60">Copies workspace files and rebuilds saved templates. Secrets stay local; reconnect agents in cloud.</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  )
}

export function ContinueLocally({ name, sandbox }) {
  const api = useApi()
  const location = useLocation()
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
  }, [name, api])

  if (sandbox?.phase !== 'ready') return null
  return (
    <div className="flex items-center gap-1">
      <Button variant="outline" size="sm" className="flex-1 justify-start text-xs" disabled={Boolean(stage) || location?.connected === false} onClick={() => {
        const nonce = crypto.randomUUID()
        const popup = window.open(localHandoffUrl(nonce), '_blank')
        if (!popup) { toast.error('Allow popups to continue locally.'); return }
        handoff.current = { popup, nonce, name, accepted: false, expires: Date.now() + 40 * 60_000 }
        setStage('connect')
      }}>
        {stage ? <Spinner className="size-3.5" /> : <Laptop className="size-3.5" aria-hidden="true" />}
        {stage === 'connect' ? 'Connecting to local OpenRod…' : stage === 'transfer' ? 'Copying and rebuilding…' : 'Continue locally'}
      </Button>
      <TooltipProvider delay={200}>
        <Tooltip>
          <TooltipTrigger render={<Button type="button" variant="ghost" size="icon-sm" aria-label="What this does" className="text-muted-foreground" />}>
            <Info className="size-3.5" aria-hidden="true" />
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-60">Open OpenRod on this computer first. Copies files and rebuilds saved templates; reconnect agents locally.</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  )
}
