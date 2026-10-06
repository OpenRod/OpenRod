import * as React from 'react'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { LocationStep } from '@/components/location-step'
import { LocationProvider } from '@/lib/location-context'
import { useInventory } from '@/lib/inventory'
import { useCompute } from '@/lib/compute'

// The destination is chosen once for a new resource, never for a whole page.
export function LocationAction({ children, onClose, subject = 'resource' }) {
  const inventory = useInventory()
  const compute = useCompute()
  const [location, setLocation] = React.useState(null)
  const [pending, setPending] = React.useState(null)
  React.useEffect(() => {
    if (!pending) return
    const found = inventory.locations.find(item=>item.target === 'local' && item.gateway === pending && item.connected)
    if (found) { setLocation(found); setPending(null) }
  }, [pending, inventory.locations])
  if (location) return <LocationProvider location={location}>{children(location, onClose)}</LocationProvider>
  return <Dialog open onOpenChange={open=>{if(!open)onClose()}}><DialogContent className="gap-4 bg-transparent p-0 ring-0 sm:max-w-3xl">
    <LocationStep locations={inventory.locations} allowRemote={Boolean(compute?.localViewer)} subject={subject} connecting={Boolean(pending)}
      onPick={id=>setLocation(inventory.locations.find(item=>(item.id ?? item.context)===id && item.connected))}
      onConnected={job=>{setPending(job.gateway);inventory.refresh()}} onCancel={onClose} />
  </DialogContent></Dialog>
}
