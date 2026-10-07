import * as React from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'
import { createApi } from '@/lib/api'
import { useCompute } from '@/lib/compute'
import { useInventory } from '@/lib/inventory'
import { resourceKey, locationLabel } from '@/lib/locations'
import { useTransferGroups } from '@/components/transfer-groups'
import { CLOUD_ORIGIN, copyLocalSandbox, localCloudRequest } from '@/lib/local-cloud'
import { SelectField } from '@/components/ui/select-field'

export function CloudBuildDialog({ open, onOpenChange }) {
  const compute = useCompute()
  const { chooseGroups, dialog } = useTransferGroups()
  const inventory = useInventory()
  const sandboxes = inventory.sandboxes.filter(sandbox => sandbox.phase === 'ready' && sandbox.location?.target !== 'cloud' && !sandbox.location?.remote && sandbox.location?.connected)
  const [choice, setChoice] = React.useState('new'), [name, setName] = React.useState('')
  const [busy, setBusy] = React.useState(false), [error, setError] = React.useState(''), [stage, setStage] = React.useState('')
  const preparation = React.useRef(null)
  React.useEffect(() => () => preparation.current?.abort(), [])
  React.useEffect(() => { if (open) { setError(''); setName('') } }, [open])
  async function start() {
    if (busy || !compute.available) return
    const source = sandboxes.find(sandbox => resourceKey(sandbox) === name)
    if (choice === 'copy' && !source) { setError('Choose a connected local sandbox.'); return }
    const controller = new AbortController()
    preparation.current = controller
    setBusy(true); setError(''); setStage('signin')
    try {
      setStage('prepare')
      const ready = await compute.prepare({ signal: controller.signal })
      const cloudInventory = await localCloudRequest('inventory', undefined, { signal: controller.signal, owner: ready.owner })
      const reported = cloudInventory.locations?.find(location => location.connected)
      if (!reported) throw Error('The cloud workspace is not ready. Refresh the connection and try again.')
      const cloudLocation = { ...reported, target: 'cloud', cloud: true, label: 'OpenRod Cloud', id: JSON.stringify(['cloud', reported.context]) }
      let copied
      if (choice === 'copy') {
        // Neither side follows the selector while a copy is in progress.
        setStage('transfer')
        const destination = createApi('cloud', controller.signal, cloudLocation.context, ready.owner)
        setStage('groups')
        const groups = await chooseGroups(destination, 'cloud', controller.signal)
        setStage('transfer')
        const result = await copyLocalSandbox(createApi('local', controller.signal, source.location.context), destination, source.name, groups)
        const context = await destination.contextKey()
        controller.signal.throwIfAborted()
        try { sessionStorage.setItem('gateway-box', JSON.stringify({ name: result.name, context, target: 'cloud' })) } catch {}
        copied = { name: result.name, context, target: 'cloud' }
        inventory.refresh()
        toast.success('Workspace ready in cloud', { description: result.warning || 'Reconnect your agent credentials to continue.' })
      }
      compute.requestCreate(choice === 'new' ? { location: cloudLocation } : false)
      onOpenChange(false)
      window.dispatchEvent(new CustomEvent('openrod-navigate', { detail: { view: 'sandboxes' } }))
      if (copied) window.dispatchEvent(new CustomEvent('openrod-sandbox-handoff', { detail: copied }))
    } catch (e) { setError(e.name === 'AbortError' ? 'Cloud preparation cancelled.' : e.message) }
    finally { setBusy(false); setStage(''); preparation.current = null }
  }
  return <Dialog open={open} onOpenChange={value => { if (!busy) onOpenChange(value) }}><DialogContent className="sm:max-w-md">
    <DialogHeader><DialogTitle>OpenRod Cloud</DialogTitle><DialogDescription>Keep using local OpenRod, your terminal and editor with your private cloud machine.</DialogDescription></DialogHeader>
    <SelectField aria-label="Cloud action" value={choice} disabled={busy} onChange={event => setChoice(event.target.value)}><option value="new">Create a cloud sandbox</option><option value="existing">Open cloud sandboxes</option><option value="copy">Copy a local sandbox</option></SelectField>
    {choice === 'copy' && <><SelectField aria-label="Local sandbox to copy" value={name} disabled={busy} onChange={e => setName(e.target.value)} className="rounded-md border bg-background p-2 text-sm"><option value="">Choose a local sandbox</option>{sandboxes.map(s => <option key={resourceKey(s)} value={resourceKey(s)}>{s.name} · {locationLabel(s.location)}</option>)}</SelectField><p className="text-xs text-muted-foreground">Copies workspace files and rebuilds saved templates. Your local source stays available. Credential files are excluded; reconnect agents in cloud.</p></>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {!compute.available && <p role="status" className="text-sm text-muted-foreground">{compute.status?.reason || 'OpenRod Cloud is not configured on this computer.'}</p>}
    <Button disabled={busy || !compute.available || (choice === 'copy' && !name)} onClick={start}>{busy && <Spinner />}{busy ? (stage === 'signin' ? 'Sign in with Google…' : stage === 'groups' ? 'Choose destination group…' : stage === 'transfer' ? 'Copying and rebuilding…' : 'Preparing cloud machine…') : choice === 'copy' ? 'Copy to OpenRod Cloud' : choice === 'new' ? 'Create in OpenRod Cloud' : 'Open OpenRod Cloud'}</Button>
    {busy && stage === 'prepare' && <Button variant="ghost" onClick={() => preparation.current?.abort()}>Cancel preparation</Button>}
    {busy && compute.connecting && <Button variant="ghost" onClick={compute.cancelConnect}>Cancel sign-in</Button>}
    {(compute.status?.origin || CLOUD_ORIGIN) && <a href={compute.status?.origin || CLOUD_ORIGIN} target="_blank" rel="noopener noreferrer" className="text-center text-xs underline">Open cloud console</a>}
    {dialog}
  </DialogContent></Dialog>
}
