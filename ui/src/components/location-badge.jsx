import { Cloud, Laptop, Monitor } from 'lucide-react'
import { locationLabel } from '@/lib/locations'

export function LocationBadge({ location }) {
  if (!location) return null
  const Icon = location.cloud || location.target === 'cloud' ? Cloud : location.remote ? Monitor : Laptop
  return <span className={`inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-normal ${location.connected ? 'border-border text-muted-foreground' : 'border-amber-500/40 text-amber-600'}`} title={location.error || `${location.gateway} · ${location.workspace}`}>
    <Icon aria-hidden="true" className="size-2.5" />{locationLabel(location)}{!location.connected && ' · Disconnected'}
  </span>
}
