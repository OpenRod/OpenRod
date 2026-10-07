import * as React from 'react'
import { PlacementBadge } from '@/components/placement-badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { useApi, LocationApiProvider, useLocation } from '@/lib/location-context'
import { resourceKey, locationLabel } from '@/lib/locations'
import { resourceCopies, matchingSources, configurationKey, applySourceChange } from '@/lib/resource-sources'

export function SourceChips({record}) {
  return <span className="flex min-w-0 flex-wrap items-center gap-1.5">{resourceCopies(record).map(copy => <PlacementBadge key={resourceKey(copy)} location={copy.location} />)}{record.configurationCount > 1 && <span className="text-[10px] leading-tight text-muted-foreground" title="Configurations differ. Open the row and select a source to inspect or edit its copy.">Varies by source</span>}</span>
}
export function SourceSwitcher({record, onChange, disabled}) {
  const copies = resourceCopies(record)
  return <div className="flex flex-wrap items-center gap-2"><span className="text-[11px] text-muted-foreground">Source</span>{copies.map(copy => <button type="button" key={resourceKey(copy)} disabled={disabled || copy.location?.connected === false} aria-pressed={resourceKey(copy) === resourceKey(record)} aria-label={`Edit in ${locationLabel(copy.location)}`} onClick={() => onChange({...copy,copies})} className="rounded-full p-0.5 outline-none aria-pressed:ring-2 aria-pressed:ring-ring focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"><PlacementBadge location={copy.location} /></button>)}</div>
}
export function SourceEditProvider({record, type, offer, children}) {
  const api = useApi(), location = useLocation()
  const wrapped = React.useMemo(() => {
    const methods = {groups:['saveGroup'],network:['savePolicy'],setups:['deleteSetupItem'],templates:['buildImageTemplate']}[type] ?? []
    return {...api, ...Object.fromEntries(methods.map(method => [method, async (...args) => {
      const result = await api[method](...args)
      if (!args[0]?.isNew) offer({type,before:record,method,args})
      return result
    }]))}
  }, [api, record, type, offer])
  return <LocationApiProvider api={wrapped} location={location}>{children}</LocationApiProvider>
}
export function useSourceChanges(records, apiFor, refresh) {
  const [pending,setPending] = React.useState(null)
  const [chosen,setChosen] = React.useState([])
  const [results,setResults] = React.useState({})
  const [busy,setBusy] = React.useState(false)
  const offer = change => {
    if (!change.before?.name || !change.before?.location) return
    const targets = matchingSources(change.before,records)
    if (!targets.length) return
    setPending({...change,targets}); setChosen([]); setResults({})
  }
  const dialog = pending && <Dialog open onOpenChange={open => {if(!open && !busy)setPending(null)}}><DialogContent className="sm:max-w-md"><DialogHeader><DialogTitle>Apply to other sources?</DialogTitle><DialogDescription>Saved in {locationLabel(pending.before.location)}. Choose where to apply the same change to “{pending.before.name}”.</DialogDescription></DialogHeader><div className="divide-y rounded-lg border">{pending.targets.map(target => {
    const key=resourceKey(target), different=configurationKey(pending.type,target)!==configurationKey(pending.type,pending.before)
    return <label key={key} className="flex items-start gap-3 p-3 text-xs"><Checkbox checked={chosen.includes(key)} disabled={busy || !target.location.connected || results[key]==='Applied'} onCheckedChange={checked=>setChosen(old=>checked?[...old,key]:old.filter(id=>id!==key))} /><span className="space-y-1"><PlacementBadge location={target.location} />{different && <span className="block text-muted-foreground">Different configuration · only changed fields will be applied.</span>}{!target.location.connected && <span className="block text-muted-foreground">Disconnected</span>}{results[key] && <span role="status" className="block">{results[key]}</span>}</span></label>
  })}</div><div className="flex justify-end gap-2"><Button variant="ghost" disabled={busy} onClick={()=>setPending(null)}>{Object.values(results).includes('Applied')?'Done':'Only this source'}</Button><Button disabled={busy || !chosen.some(key=>results[key]!=='Applied')} onClick={async()=>{
    setBusy(true)
    for(const target of pending.targets.filter(target=>chosen.includes(resourceKey(target)) && results[resourceKey(target)]!=='Applied')) {
      let result
      try { const saved=await applySourceChange(pending,target,apiFor(target.location)); result=saved?.sync?.error || saved?.sync?.failed?.length ? 'Saved; sandbox synchronization needs attention.' : 'Applied' } catch(error) {result=error.message}
      setResults(old=>({...old,[resourceKey(target)]:result}))
    }
    try { await refresh() } finally { setBusy(false) }
  }}>{busy?'Applying…':'Apply selected'}</Button></div></DialogContent></Dialog>
  return {offer,dialog}
}
