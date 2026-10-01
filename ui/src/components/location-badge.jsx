import { locationLabel } from '@/lib/locations'

export function LocationBadge({ location }) {
  if (!location) return null
  return <span className={`inline-flex shrink-0 items-center rounded border px-1.5 py-0.5 text-[10px] font-normal ${location.connected ? 'border-border text-muted-foreground' : 'border-amber-500/40 text-amber-600'}`} title={location.error || `${location.gateway} · ${location.workspace}`}>
    {locationLabel(location)}{!location.connected && ' · Disconnected'}
  </span>
}
