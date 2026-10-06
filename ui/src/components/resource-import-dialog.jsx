import * as React from 'react'
import { ArrowRight, Check, FolderInput, RotateCw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { SelectField } from '@/components/ui/select-field'
import { Spinner } from '@/components/ui/spinner'
import { Input } from '@/components/ui/input'
import { BlurFade } from '@/components/ui/blur-fade'
import { useCompute, useApi } from '@/lib/compute'
import { useInventory } from '@/lib/inventory'
import { createApi } from '@/lib/api'
import { localCloudRequest } from '@/lib/local-cloud'
import { IMPORT_TYPES, DEFAULT_IMPORT_TYPES, groupImportResources, activityImportQuery, importRunning, importFinished, importSelection, importSourceId, importPercent } from '@/lib/resource-imports'
import { locationLabel } from '@/lib/locations'

const labels = { ...Object.fromEntries(IMPORT_TYPES.map(type => [type.id, type.label])), policyTemplates: 'Base policy' }
const statusLabel = value => ({ created: 'Imported', completed: 'Imported', reused: 'Reused', failed: 'Failed', blocked: 'Dependency failed', pending: 'Waiting', running: 'Importing', cancelled: 'Cancelled', skipped: 'Skipped', planned: 'Ready to import', partial: 'Needs attention', interrupted: 'Interrupted' }[value] ?? value)

export function ResourceImportDialog({ request, onClose }) {
  const compute = useCompute()
  const base = useApi()
  const inventory = useInventory()
  const [sourceId, setSourceId] = React.useState('')
  const [destinationId, setDestinationId] = React.useState(() => request?.destination ? importSourceId(request.destination) : compute?.localViewer ? 'cloud' : '')
  const [cloudLocation, setCloudLocation] = React.useState(request?.destination ?? null)
  const [types, setTypes] = React.useState(() => request?.type && labels[request.type] ? [request.type] : DEFAULT_IMPORT_TYPES)
  const [activity, setActivity] = React.useState({ from: '', to: '' })
  const [capabilities, setCapabilities] = React.useState(null)
  const [conflicts, setConflicts] = React.useState({})
  const [bundle, setBundle] = React.useState(null)
  const [selected, setSelected] = React.useState([])
  const [job, setJob] = React.useState(null)
  const [recent, setRecent] = React.useState([])
  const [busy, setBusy] = React.useState('')
  const [error, setError] = React.useState('')
  const [destinationApi, setDestinationApi] = React.useState(null)
  const sourceLocations = inventory.locations.filter(location => location.connected)
  const storedCloudLocation = cloudLocation && (inventory.locations.find(location => importSourceId(location) === importSourceId(cloudLocation)) ?? cloudLocation)
  const locations = storedCloudLocation?.connected && !sourceLocations.some(location => importSourceId(location) === importSourceId(cloudLocation)) ? [...sourceLocations, storedCloudLocation] : sourceLocations
  const source = locations.find(location => importSourceId(location) === sourceId)
  const destination = locations.find(location => importSourceId(location) === destinationId)
  const controller = React.useRef(new AbortController())
  const lifetime = React.useRef(0)
  React.useEffect(() => { const generation = ++lifetime.current; return () => queueMicrotask(() => { if (lifetime.current === generation) controller.current.abort() }) }, [])
  const cloudOwner = React.useRef(compute?.status?.owner ?? null)
  if (!cloudOwner.current && compute?.status?.owner) cloudOwner.current = compute.status.owner
  const signal = React.useMemo(() => base.signal ? AbortSignal.any([base.signal, controller.current.signal]) : controller.current.signal, [base.signal])
  const apiFor = React.useCallback(location => createApi(compute?.localViewer ? location.target : base.target, signal, location.context, cloudOwner.current), [compute?.localViewer, base.target, signal])
  React.useEffect(() => {
    if (!sourceId && sourceLocations.length) setSourceId(importSourceId(sourceLocations.find(location => !location.cloud && !location.remote) ?? sourceLocations[0]))
  }, [sourceId, sourceLocations.map(importSourceId).join('|')])
  React.useEffect(() => {
    if (destinationId !== 'cloud') return
    const ready = locations.find(location => (location.cloud || location.target === 'cloud') && location.connected)
    if (ready) setDestinationId(importSourceId(ready))
  }, [destinationId, locations.map(location => `${importSourceId(location)}:${location.connected}`).join('|')])
  React.useEffect(() => {
    setRecent([])
    if (!destination?.connected) return
    const api = apiFor(destination)
    let alive = true
    api.importJobs().then(result => { if (alive) setRecent(result.jobs ?? []) }).catch(() => { if (alive) setRecent([]) })
    return () => { alive = false }
  }, [destinationId, destination?.context, destination?.connected, apiFor, job?.id, job?.status])
  React.useEffect(() => {
    if (!job || !importRunning(job) || !destinationApi) return
    let alive = true, timer
    const poll = async () => {
      try {
        const next = await destinationApi.importJob(job.id)
        if (!alive) return
        setJob(next)
        if (importRunning(next)) timer = setTimeout(poll, 1000)
        else { inventory.refresh(); window.dispatchEvent(new Event('openrod-resources-changed')) }
      } catch (e) { if (alive) { setError(e.message); timer = setTimeout(poll, 3000) } }
    }
    poll()
    return () => { alive = false; clearTimeout(timer) }
  }, [job?.id, job?.status, destinationApi])
  async function run(label, action) {
    setBusy(label); setError('')
    try { await action() } catch (e) { if (e.name !== 'AbortError') setError(e.message) }
    finally { if (!signal.aborted) setBusy('') }
  }
  async function resolveDestination() {
    if (destination?.connected) return destination
    if (destinationId !== 'cloud') throw Error('Choose a connected destination.')
    if (!compute?.localViewer) throw Error('Choose the cloud workspace from the list.')
    signal.throwIfAborted()
    setBusy(compute.connected ? 'Preparing cloud workspace…' : 'Connecting to OpenRod Cloud…')
    const ready = await compute.prepare({ signal, onProgress: () => {
      if (!signal.aborted) setBusy('Preparing cloud workspace…')
    } })
    if (cloudOwner.current && cloudOwner.current !== ready.owner) throw Error('Your cloud account changed. Start a new import.')
    cloudOwner.current = ready.owner
    signal.throwIfAborted()
    const result = await localCloudRequest('inventory', undefined, { signal, owner: ready.owner })
    const location = result.locations?.find(value => value.connected)
    if (!location) throw Error('The cloud gateway is still preparing. Try again shortly.')
    const value = { ...location, cloud: true, target: 'cloud', label: 'OpenRod Cloud', id: JSON.stringify(['cloud', location.context]) }
    setCloudLocation(value); setDestinationId(value.id); inventory.refresh()
    return value
  }
  async function inspect(nextActivity = activity) {
    if (!source) throw Error('Choose a connected source.')
    const sourceApi = apiFor(source)
    const activityQuery = types.includes('activity') ? activityImportQuery(nextActivity) : undefined
    const target = await resolveDestination()
    signal.throwIfAborted()
    setBusy('Reading configuration…')
    if (importSourceId(source) === importSourceId(target)) throw Error('Choose a different destination.')
    const api = apiFor(target)
    const capabilities = await api.importCapabilities()
    const unsupported = types.filter(type => !capabilities.types?.[type]?.supported)
    if (unsupported.length) throw Error(`This destination cannot import ${unsupported.map(type => labels[type]).join(', ')}.`)
    const value = await sourceApi.exportResources({ types, ...(activityQuery ? { activity: activityQuery } : {}) })
    setCapabilities(capabilities); setConflicts({}); setDestinationApi(api); setBundle(value)
    setSelected(value.resources.filter(item => types.includes(item.type)).map(item => item.key))
  }
  const selection = React.useMemo(() => {
    try {
      const included = bundle ? importSelection(bundle.resources, selected) : []
      const unsupported = [...new Set(bundle?.resources.filter(item => included.includes(item.key) && capabilities && !capabilities.types?.[item.type]?.supported).map(item => item.type) ?? [])]
      return { included, error: unsupported.length ? `Required dependencies cannot be imported here: ${unsupported.map(type => labels[type] ?? type).join(', ')}.` : '' }
    } catch (reason) { return { included: selected, error: `${reason.message}. Deselect the resource that requires it, or fix the source and read it again.` } }
  }, [bundle, selected, capabilities])
  async function changeConflict(item, action) {
    const next = { ...conflicts }
    if (action === 'reuse') next[item.key] = { action, targetId: item.sourceId }
    else delete next[item.key]
    const plan = await destinationApi.planImport({ bundle, selection: selected, conflicts: next })
    setConflicts(next); setJob(plan)
  }
  const included = selection.included
  const stage = job ? 'result' : bundle ? 'select' : 'source'
  const frozen = Boolean(busy) || importRunning(job)
  function reset() { setBundle(null); setJob(null); setSelected([]); setConflicts({}); setActivity(value => ({ from: value.from, to: value.to })); setError('') }
  const selectionRow = item => <label key={item.key} className="flex items-start gap-3 p-3"><Checkbox aria-label={`Import ${item.name}`} checked={included.includes(item.key)} disabled={frozen || (!selected.includes(item.key) && included.includes(item.key))} onCheckedChange={checked => setSelected(values => checked ? [...values, item.key] : values.filter(value => value !== item.key))} /><span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium">{item.name}</span><span className="text-[11px] text-muted-foreground">{included.includes(item.key) && !selected.includes(item.key) ? 'Required dependency' : ''}</span>{item.type === 'setups' && ['mcp', 'skill'].map(kind => {
              const entries = (item.data?.items ?? []).filter(entry => entry.kind === kind)
              return entries.length > 0 && <span key={kind} className="mt-1 block text-[11px] leading-relaxed text-muted-foreground"><span className="font-medium">{kind === 'mcp' ? 'MCPs' : 'Skills'}:</span> {entries.map(entry => entry.name).join(', ')}</span>
            })}{item.warnings?.map((warning, i) => <span key={i} className="mt-1 block text-[11px] text-amber-700 dark:text-amber-400">{warning}</span>)}</span></label>
  const description = job ? `${job.counts?.completed ?? 0} of ${job.items.length} resources complete. Your source stays available.` : bundle ? 'Choose what to copy. Required dependencies are included in the review.' : 'Copy saved configuration between your computer, connected hosts, and OpenRod Cloud.'
  return <Dialog open onOpenChange={value => { if (!value && !busy) onClose() }}><DialogContent className="gap-4 sm:max-w-xl">
    <DialogHeader className="pr-6"><DialogTitle>{job ? statusLabel(job.status) : 'Import data'}</DialogTitle><DialogDescription className="text-xs leading-relaxed">{description}</DialogDescription></DialogHeader>
    <div className="flex items-center gap-2 text-[11px] text-muted-foreground" aria-label="Import steps">
      {['Locations', 'Selection', 'Review & import'].map((label, i) => <React.Fragment key={label}>{i > 0 && <ArrowRight className="size-3" />}<span className={i === (stage === 'source' ? 0 : stage === 'select' ? 1 : 2) ? 'font-medium text-foreground' : ''}>{label}</span></React.Fragment>)}
    </div>
    <div className="max-h-[60svh] overflow-y-auto pr-1">
      {stage === 'source' && <BlurFade duration={0.15} offset={3} className="space-y-5">
        <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-3">
          <label className="grid gap-2 text-xs font-medium">From<SelectField aria-label="Import source" value={sourceId} onChange={e => { setSourceId(e.target.value); setActivity(value => ({ from: value.from, to: value.to })) }} disabled={frozen} className="w-full text-xs"><option value="">Choose source</option>{sourceLocations.map(location => <option key={importSourceId(location)} value={importSourceId(location)}>{locationLabel(location)}</option>)}</SelectField></label>
          <ArrowRight className="mb-2 size-4 text-muted-foreground" />
          <label className="grid gap-2 text-xs font-medium">To<SelectField aria-label="Import destination" value={destinationId} onChange={e => { setDestinationId(e.target.value); setRecent([]) }} disabled={frozen} className="w-full text-xs"><option value="">Choose destination</option>{compute?.localViewer && (destinationId === 'cloud' || !locations.some(location => location.cloud || location.target === 'cloud')) && <option value="cloud" disabled={!compute?.available}>OpenRod Cloud{!compute?.available ? " · Not configured" : ""}</option>}{locations.map(location => <option key={importSourceId(location)} value={importSourceId(location)} disabled={importSourceId(location) === sourceId}>{locationLabel(location)}</option>)}</SelectField></label>
        </div>
        <fieldset className="space-y-1"><legend className="mb-2 text-xs font-medium">Include</legend>{IMPORT_TYPES.map(type => <label key={type.id} className="flex cursor-pointer items-center gap-3 rounded-md p-2 hover:bg-muted/50"><Checkbox checked={types.includes(type.id)} disabled={frozen} onCheckedChange={checked => setTypes(values => checked ? [...values, type.id] : values.filter(value => value !== type.id))} /><span><span className="block text-xs font-medium">{type.label}</span><span className="text-[11px] text-muted-foreground">{type.description}</span></span></label>)}</fieldset>
        {types.includes('activity') && <div className="grid gap-2 rounded-lg border bg-muted/20 p-3"><p className="text-[11px] text-muted-foreground">Up to 500 events per reviewed batch. Leave dates empty for the latest history. Dates use your current timezone.</p><div className="grid gap-3 sm:grid-cols-2"><label className="grid gap-1.5 text-[11px]">From<Input type="datetime-local" value={activity.from} disabled={frozen} onChange={event => setActivity(value => ({ from: event.target.value, to: value.to }))} className="text-xs" /></label><label className="grid gap-1.5 text-[11px]">To<Input type="datetime-local" value={activity.to} disabled={frozen} onChange={event => setActivity(value => ({ from: value.from, to: event.target.value }))} className="text-xs" /></label></div></div>}
        <p className="rounded-md border border-border bg-muted/20 p-3 text-[11px] leading-relaxed text-muted-foreground">Credentials must be connected at the destination. Sandbox workspace copying is available from each sandbox. Activity history is copied only when selected; raw payloads and credential values are excluded.</p>
        {recent.length > 0 && <div className="space-y-1 border-t pt-3"><p className="mb-2 text-xs font-medium">Recent imports at this destination</p>{recent.slice(0, 5).map(item => <button key={item.id} className="flex w-full items-center justify-between rounded-md p-2 text-left text-xs hover:bg-muted" disabled={frozen} onClick={() => { setDestinationApi(apiFor(destination)); setJob(item) }}><span>{item.source?.label || 'Configuration import'} <span className="text-muted-foreground">· {item.items?.length ?? item.counts?.total ?? 0} resources</span></span><span className="text-[11px] text-muted-foreground">{statusLabel(item.status)}</span></button>)}</div>}
      </BlurFade>}
      {stage === 'select' && <div className="space-y-3">
        <p className="flex items-center gap-2 text-xs"><span>{locationLabel(source)}</span><ArrowRight className="size-3 text-muted-foreground" /><span>{locationLabel(destination)}</span></p>
        {!bundle.resources.length && <p className="py-8 text-center text-xs text-muted-foreground">No saved resources were found for these categories. For MCPs and skills, use Bring my setup on the source first.</p>}
        <div className="flex items-center justify-between text-[11px] text-muted-foreground"><span>{included.length} selected{included.length > selected.length ? ` · ${included.length - selected.length} required dependencies` : ''}</span><Button variant="ghost" size="sm" disabled={frozen} onClick={() => setSelected(selected.length ? [] : bundle.resources.filter(item => types.includes(item.type)).map(item => item.key))}>{selected.length ? 'Clear selection' : 'Select all'}</Button></div>
        <div className="space-y-5">{groupImportResources(bundle.resources).map(section => <section key={section.id} aria-labelledby={`import-section-${section.id}`} className="space-y-2">
          <h3 id={`import-section-${section.id}`} className="flex items-center justify-between text-xs font-semibold"><span>{section.label}</span><span className="text-[11px] font-normal tabular-nums text-muted-foreground">{section.items.filter(item => included.includes(item.key)).length} / {section.items.length}</span></h3>
          {section.groups ? <div className="space-y-3">{section.groups.map(group => <section key={group.id} aria-labelledby={`import-subsection-${group.id}`} className="space-y-1.5">
            <h4 id={`import-subsection-${group.id}`} className="text-[11px] font-medium text-muted-foreground">{group.label}</h4>
            <div className="divide-y rounded-lg border">{group.items.map(selectionRow)}</div>
          </section>)}</div> : <div className="divide-y rounded-lg border">{section.items.map(selectionRow)}</div>}
        </section>)}</div>
        {selection.error && <p role="alert" className="text-xs text-destructive">{selection.error}</p>}
        {bundle.pages?.activity && <p className="text-[11px] text-muted-foreground">{bundle.pages.activity.exported} of {bundle.pages.activity.total} matching activity events in this batch.{bundle.pages.activity.nextOffset != null ? ' After importing, load the next batch to continue with older history.' : ''}</p>}
        {bundle.excluded?.length > 0 && <details className="text-[11px] text-muted-foreground"><summary className="cursor-pointer">{bundle.excluded.length} excluded or needing attention</summary><ul className="mt-2 space-y-1">{bundle.excluded.map((item, i) => <li key={i}>{item.name ?? labels[item.type] ?? item.type}: {item.reason}</li>)}</ul></details>}
      </div>}
      {job && <div className="space-y-3">
        <div className="flex items-center justify-between text-xs"><span>{job.source?.label || 'Source'} → {destination ? locationLabel(destination) : 'Destination'}</span><span className="text-muted-foreground">{job.items.length} resources</span></div>
        {job.status !== 'planned' && <div role="progressbar" aria-label="Import progress" aria-valuenow={importPercent(job)} aria-valuemin={0} aria-valuemax={100} className="h-1 overflow-hidden rounded-full bg-muted"><div className="h-full bg-primary transition-[width] motion-reduce:transition-none" style={{ width: `${importPercent(job)}%` }} /></div>}
        <div className="divide-y rounded-lg border">{job.items.map(item => <div key={item.key} className="flex items-start gap-3 p-3">{item.status === 'running' ? <Spinner className="mt-0.5 size-3.5" /> : ['created', 'completed', 'reused'].includes(item.status) ? <Check className="mt-0.5 size-3.5 text-emerald-600" /> : item.status === 'failed' ? <X className="mt-0.5 size-3.5 text-destructive" /> : <FolderInput className="mt-0.5 size-3.5 text-muted-foreground" />}<span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium">{item.name}</span><span className="block text-[11px] text-muted-foreground">{labels[item.type]} · {job.status === 'planned' ? item.action === 'reuse' ? 'Use existing' : 'Create a copy' : statusLabel(item.status)}</span>{item.warnings?.map((warning, i) => <span key={i} className="mt-1 block text-[11px] text-amber-700 dark:text-amber-400">{warning}</span>)}{item.error && <span className="mt-1 block text-[11px] text-destructive">{typeof item.error === 'string' ? item.error : item.error.message}</span>}{job.status === 'planned' && bundle && item.type !== 'activity' && <SelectField aria-label={`Import action for ${item.name}`} value={item.action} disabled={frozen} onChange={event => run('Updating review…', () => changeConflict(item, event.target.value))} className="mt-2 h-7 w-fit min-w-40 text-[11px]"><option value="create">Create a copy</option><option value="reuse">Use identical existing</option></SelectField>}</span></div>)}</div>
        {job.status === 'planned' && bundle && <p className="text-[11px] text-muted-foreground">Existing resources can be reused only when their ID and configuration match. Copies receive a new ID when needed.</p>}
        {job.warnings?.map((warning, i) => <p key={i} className="text-[11px] text-muted-foreground">{warning}</p>)}
        {importRunning(job) && <p className="text-[11px] text-muted-foreground">You can close this dialog. Reopen Import data at this destination to check progress.</p>}
      </div>}
    </div>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    <DialogFooter>
      {busy && !importRunning(job) && <Button size="sm" variant="ghost" onClick={() => { controller.current.abort(); onClose() }}>Cancel</Button>}
      {stage !== 'source' && !importRunning(job) && <Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={reset}>Start another import</Button>}
      {stage === 'source' && <Button size="sm" disabled={frozen || !source || !destinationId || !types.length || sourceId === destinationId || (destinationId === 'cloud' && !compute?.available)} onClick={() => run('Reading configuration…', () => inspect())}>{busy ? <Spinner /> : <FolderInput />}{busy || 'Choose resources'}</Button>}
      {stage === 'select' && <Button size="sm" disabled={frozen || !selected.length || Boolean(selection.error)} onClick={() => run('Preparing review…', async () => setJob(await destinationApi.planImport({ bundle, selection: selected, conflicts })))}>{busy && <Spinner />}{busy || `Review ${included.length} resources`}</Button>}
      {job?.status === 'planned' && <Button size="sm" disabled={frozen} onClick={() => run('Starting import…', async () => setJob(await destinationApi.executeImport(job.id)))}>{busy && <Spinner />}{busy || 'Import selected data'}</Button>}
      {importRunning(job) && <Button size="sm" variant="outline" disabled={Boolean(busy) || job.cancelRequested || job.status === 'cancelling'} onClick={() => run('Cancelling…', async () => setJob(await destinationApi.cancelImport(job.id)))}>{job.cancelRequested ? 'Cancelling…' : 'Cancel import'}</Button>}
      {importFinished(job) && (job.counts?.failed > 0 || job.items.some(item => ['failed', 'blocked', 'cancelled', 'pending'].includes(item.status))) && <Button size="sm" disabled={Boolean(busy)} onClick={() => run('Retrying…', async () => setJob(await destinationApi.retryImport(job.id)))}><RotateCw />Retry unfinished</Button>}
      {job?.status === 'completed' && job.items.some(item => item.type === 'activity') && bundle?.pages?.activity?.nextOffset != null && <Button size="sm" variant="outline" disabled={Boolean(busy) || !source} onClick={() => run('Reading older history…', async () => { const next = { ...activity, offset: bundle.pages.activity.nextOffset, snapshot: bundle.pages.activity.snapshot }; setActivity(next); setTypes(['activity']); const api = apiFor(source); const nextBundle = await api.exportResources({ types: ['activity'], activity: activityImportQuery(next) }); setBundle(nextBundle); setSelected(nextBundle.resources.map(item => item.key)); setConflicts({}); setJob(null) })}>Next history batch</Button>}
      {job && job.status !== 'planned' && <Button size="sm" variant="outline" onClick={onClose}>Close</Button>}
    </DialogFooter>
  </DialogContent></Dialog>
}
