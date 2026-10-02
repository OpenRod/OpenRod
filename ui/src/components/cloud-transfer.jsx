import * as React from 'react'
import { Cloud, Info, Laptop } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { createApi } from '@/lib/api'
import { useCompute } from '@/lib/compute'
import { useApi, useLocation } from '@/lib/location-context'
import { useInventory } from '@/lib/inventory'
import { copyLocalSandbox, copyCloudSandboxToLocal, localCloudRequest, waitForCloudReady } from '@/lib/local-cloud'
import { useTransferGroups } from '@/components/transfer-groups'
import { LOCAL_ORIGIN, localHandoffUrl, isLocalHandoffMessage } from '@/lib/cloud-transfer'
import { CLOUD_AVAILABLE } from '@/lib/cloud-origin'
import { CloudSoon } from '@/components/cloud-soon'

export function ContinueInCloud({ name, sandbox }) {
  const api = useApi()
  const compute = useCompute()
  const location = useLocation()
  const { refresh } = useInventory()
  const { chooseGroups, dialog } = useTransferGroups()
  const transfer = React.useRef(null)
  React.useEffect(() => () => transfer.current?.abort(), [])
  const [stage, setStage] = React.useState(null)
  async function copy() {
    if (stage || location?.connected === false) return
    const controller = new AbortController()
    transfer.current = controller
    const signal = api.signal ? AbortSignal.any([api.signal, controller.signal]) : controller.signal
    setStage('signin')
    try {
      await compute.connect()
      setStage('prepare')
      signal.throwIfAborted()
      await waitForCloudReady(() => localCloudRequest('machine', undefined, { signal }), { signal })
      const destination = createApi('cloud', signal)
      setStage('groups')
      const groups = await chooseGroups(destination, 'cloud', signal)
      setStage('transfer')
      const result = await copyLocalSandbox(createApi(api.target, signal, location?.context), destination, name, groups)
      signal.throwIfAborted()
      toast.success('Workspace ready in cloud', { description: result.warning || 'Reconnect your agent credentials to continue.' })
      const context = await destination.contextKey()
      try { sessionStorage.setItem('gateway-box', JSON.stringify({ name: result.name, context, target: 'cloud' })) } catch {}
      refresh()
      compute.selectTarget('cloud')
      window.dispatchEvent(new CustomEvent('openrod-sandbox-handoff', { detail: { name: result.name, context, target: 'cloud' } }))
    } catch (error) { if (error.name !== 'AbortError') toast.error('Couldn’t continue in cloud', { description: error.message }) }
    finally { if (!controller.signal.aborted) setStage(null); if (transfer.current === controller) transfer.current = null }
  }
  if (sandbox?.phase !== 'ready') return null
  if (!CLOUD_AVAILABLE) return <CloudSoon className="w-full justify-start text-xs"><Cloud className="size-3.5" aria-hidden="true" />Continue in cloud</CloudSoon>
  return <div className="flex items-center gap-1">
    {dialog}
    <Button variant="outline" size="sm" className="flex-1 justify-start text-xs" disabled={Boolean(stage) || location?.connected === false} onClick={copy}>
      {stage ? <Spinner className="size-3.5" /> : <Cloud className="size-3.5" aria-hidden="true" />}
      {stage === 'signin' ? 'Sign in to cloud…' : stage === 'prepare' ? 'Preparing cloud machine…' : stage === 'groups' ? 'Choose destination group…' : stage === 'transfer' ? 'Copying and rebuilding…' : 'Continue in cloud'}
    </Button>
    <TooltipProvider delay={200}>
      <Tooltip>
        <TooltipTrigger render={<Button type="button" variant="ghost" size="icon-sm" aria-label="What this does" className="text-muted-foreground" />}>
          <Info className="size-3.5" aria-hidden="true" />
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-60">Copies workspace files and rebuilds saved templates. Your local source stays available. Credential files are excluded; reconnect agents in cloud.</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  </div>
}

export function ContinueLocally({ name, sandbox }) {
  const api = useApi()
  const compute = useCompute()
  const location = useLocation()
  const { locations, refresh } = useInventory()
  const { chooseGroups, dialog } = useTransferGroups()
  const transfer = React.useRef(null)
  React.useEffect(() => () => transfer.current?.abort(), [])
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
  async function importLocally() {
    if (stage || location?.connected === false) return
    const destinationLocation = locations.find(item => item.target !== 'cloud' && !item.remote && item.connected)
    if (!destinationLocation) { toast.error('Connect a local gateway before importing this workspace.'); return }
    const controller = new AbortController()
    transfer.current = controller
    const signal = api.signal ? AbortSignal.any([api.signal, controller.signal]) : controller.signal
    setStage('transfer')
    try {
      const destination = createApi('local', signal, destinationLocation.context)
      setStage('groups')
      const groups = await chooseGroups(destination, 'local OpenRod', signal)
      setStage('transfer')
      const result = await copyCloudSandboxToLocal(createApi(api.target, signal, location?.context), destination, name, groups)
      signal.throwIfAborted()
      toast.success('Workspace running locally', { description: result.warning || 'Your cloud source is unchanged. Reconnect agent credentials locally.' })
      try { sessionStorage.setItem('gateway-box', JSON.stringify({ name: result.name, context: destinationLocation.context, target: 'local' })) } catch {}
      refresh()
      compute.selectTarget('local')
      window.dispatchEvent(new CustomEvent('openrod-sandbox-handoff', { detail: { name: result.name, context: destinationLocation.context, target: 'local' } }))
    } catch(error) {
      if(error.name !== 'AbortError') toast.error('Couldn’t import locally', {description:error.message})
    } finally { if (!controller.signal.aborted) setStage(null); if (transfer.current === controller) transfer.current = null }
  }
  if (compute?.localViewer && !CLOUD_AVAILABLE) return <CloudSoon className="w-full justify-start text-xs"><Laptop className="size-3.5" aria-hidden="true" />Import and run locally</CloudSoon>
  return (
    <div className="flex items-center gap-1">
      {dialog}
      <Button variant="outline" size="sm" className="flex-1 justify-start text-xs" disabled={Boolean(stage) || location?.connected === false} onClick={() => {
        if (compute?.localViewer) { importLocally(); return }
        const nonce = crypto.randomUUID()
        const popup = window.open(localHandoffUrl(nonce), '_blank')
        if (!popup) { toast.error('Allow popups to continue locally.'); return }
        handoff.current = { popup, nonce, name, accepted: false, expires: Date.now() + 40 * 60_000 }
        setStage('connect')
      }}>
        {stage ? <Spinner className="size-3.5" /> : <Laptop className="size-3.5" aria-hidden="true" />}
        {stage === 'connect' ? 'Connecting to local OpenRod…' : stage === 'groups' ? 'Choose destination group…' : stage === 'transfer' ? 'Copying and rebuilding…' : 'Import and run locally'}
      </Button>
      <TooltipProvider delay={200}>
        <Tooltip>
          <TooltipTrigger render={<Button type="button" variant="ghost" size="icon-sm" aria-label="What this does" className="text-muted-foreground" />}>
            <Info className="size-3.5" aria-hidden="true" />
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-60">{compute?.localViewer ? 'Creates a separate local sandbox, copies files and rebuilds the image for this computer. Your cloud source stays available.' : 'Open OpenRod on this computer first. Creates a local sandbox, copies files and rebuilds saved templates.'} Reconnect agents locally.</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  )
}
