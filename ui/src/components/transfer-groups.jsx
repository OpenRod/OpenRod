import * as React from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { SelectField } from '@/components/ui/select-field'
import { groupNetworkPolicies } from '../../shared/group-network.js'

// Groups belong to the destination. Never reuse source IDs across gateways.
export function useTransferGroups() {
  const [choice, setChoice] = React.useState(null)
  const [selected, setSelected] = React.useState('')
  const pending = React.useRef(null)
  const mounted = React.useRef(true)
  const settle = React.useCallback((groups, error, update = true) => {
    const current = pending.current
    if (!current) return
    pending.current = null
    current.cleanup()
    if (update) setChoice(null)
    if (error) current.reject(error)
    else current.resolve(groups)
  }, [])
  const cancel = React.useCallback(() => settle(undefined, new DOMException('Workspace transfer cancelled.', 'AbortError')), [settle])
  React.useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; settle(undefined, new DOMException('Workspace transfer cancelled.', 'AbortError'), false) }
  }, [settle])
  const chooseGroups = React.useCallback(async (destination, label, signal) => {
    signal?.throwIfAborted()
    const org = await destination.org()
    if (!mounted.current) throw new DOMException('Workspace transfer cancelled.', 'AbortError')
    signal?.throwIfAborted()
    const groups = (org.groups ?? []).filter(group => groupNetworkPolicies(org.policies ?? [], [group.id]).length > 0)
    if (!groups.length) throw new Error(`Add a group with a network rule in ${label} before copying this workspace.`)
    // The server can select a sole eligible destination group itself.
    if (groups.length === 1) return undefined
    if (pending.current) throw new Error('Finish the current workspace transfer first.')
    setSelected('')
    setChoice({ groups, label })
    return new Promise((resolve, reject) => {
      const aborted = () => settle(undefined, new DOMException('Workspace transfer cancelled.', 'AbortError'))
      pending.current = { resolve, reject, cleanup: () => signal?.removeEventListener('abort', aborted) }
      signal?.addEventListener('abort', aborted, { once: true })
      if (signal?.aborted) aborted()
    })
  }, [settle])
  const dialog = <Dialog open={Boolean(choice)} onOpenChange={open => { if (!open) cancel() }}>
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Choose a destination group</DialogTitle>
        <DialogDescription>The copied sandbox inherits this group’s network rules in {choice?.label}.</DialogDescription>
      </DialogHeader>
      <SelectField aria-label="Destination sandbox group" value={selected} onChange={event => setSelected(event.target.value)} className="h-9 rounded-md border bg-background px-2 text-sm">
        <option value="">Choose a group</option>
        {choice?.groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}
      </SelectField>
      <DialogFooter>
        <Button variant="ghost" onClick={cancel}>Cancel</Button>
        <Button disabled={!choice?.groups.some(group => group.id === selected)} onClick={() => settle([selected])}>Copy workspace</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
  return { chooseGroups, dialog, cancel }
}
