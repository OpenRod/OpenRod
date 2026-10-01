import { PLACEMENTS, placementOf } from '@/lib/placement'
import { locationLabel } from '@/lib/locations'

// One family of 16px line icons, each with the same small face.
const Face = ({ x, y }) => <>
  <circle cx={x - 1.6} cy={y} r=".7" fill="currentColor" stroke="none" />
  <circle cx={x + 1.6} cy={y} r=".7" fill="currentColor" stroke="none" />
  <path d={`M${x - 1.1} ${y + 1.5}q1.1 1 2.2 0`} />
</>

const ICONS = {
  local: () => <>
    <rect x="2.5" y="2.5" width="11" height="8" rx="1.8" />
    <path d="M1 13.5h14" />
    <Face x={8} y={6} />
  </>,
  remote: () => <>
    <rect x="3" y="5" width="10" height="9" rx="2" />
    <path d="M5.8 3a3.2 3.2 0 0 1 4.4 0" />
    <circle cx="8" cy="1.6" r=".55" fill="currentColor" stroke="none" className="motion-safe:animate-pulse" />
    <Face x={8} y={8.8} />
  </>,
  cloud: () => <>
    <path d="M4.5 13.5a3 3 0 0 1-.4-6 4 4 0 0 1 7.7-.7 3.4 3.4 0 0 1-.1 6.7z" />
    <path d="M13.6 1.2v2M12.6 2.2h2" className="motion-safe:animate-pulse" />
    <Face x={7.6} y={9.6} />
  </>,
}

const TONE = {
  local: 'bg-indigo-50 text-indigo-700 ring-indigo-200 dark:bg-indigo-500/15 dark:text-indigo-300 dark:ring-indigo-400/30',
  remote: 'bg-fuchsia-50 text-fuchsia-700 ring-fuchsia-200 dark:bg-fuchsia-500/15 dark:text-fuchsia-300 dark:ring-fuchsia-400/30',
  cloud: 'bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-500/15 dark:text-sky-300 dark:ring-sky-400/30',
}

export function PlacementIcon({ type, className = 'size-3.5' }) {
  const Icon = ICONS[type]
  return <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`shrink-0 overflow-visible transition-transform duration-200 motion-safe:group-hover:-translate-y-px motion-safe:group-hover:-rotate-6 ${className}`}><Icon /></svg>
}

export function PlacementPill({ type, title }) {
  return <span title={title} className={`inline-flex shrink-0 items-center gap-1 rounded-full py-0.5 pr-2 pl-1.5 text-[11px] font-medium ring-1 ring-inset ${TONE[type]}`}>
    <PlacementIcon type={type} />{PLACEMENTS[type].label}
  </span>
}

export function PlacementBadge({ location }) {
  const type = placementOf(location)
  return <PlacementPill type={type} title={`${PLACEMENTS[type].hint} · ${locationLabel(location)}`} />
}
