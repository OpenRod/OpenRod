import * as React from 'react'
import { ArrowRight, Copy, HardDrive, Pencil, Plus, RotateCw, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { BlurFade } from '@/components/ui/blur-fade'
import { Spinner } from '@/components/ui/spinner'
import { ImageTemplateBuilder } from '@/components/image-template-builder'
import { CreateSandboxDialog } from '@/components/create-sandbox-dialog'
import { createApi } from '@/lib/api'
import { useCompute } from '@/lib/compute'
import { useInventory } from '@/lib/inventory'
import { LocationProvider, useApi } from '@/lib/location-context'
import { resourceKey, locationLabel } from '@/lib/locations'
import { LocationBadge } from '@/components/location-badge'
import { PlacementBadge } from '@/components/placement-badge'
import { AGENTS, STARTS, pendingRecipe, pendingRecipeKey } from '@/lib/image-templates'
import { SearchInput } from "@/components/ui/search-input"
import { SelectField } from '@/components/ui/select-field'
import { LocationStep } from '@/components/location-step'

const locationKey = (location) => location?.id ?? location?.context
const action = 'bg-[var(--action)] text-[var(--action-foreground)] hover:bg-[var(--action)]/90'
const working = (t) => t.status === 'building'
// A template stays usable while its rebuild runs or after a rebuild fails.
export const launchable = (t) => t.status === 'ready' || t.exists
const statusLabel = (t) => working(t) ? (t.exists ? 'Rebuilding' : 'Building') : t.status === 'failed' ? (t.exists ? 'Rebuild failed' : 'Build failed') : 'Ready'
function Status({ record }) {
  if (record.location?.connected === false) return <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[11px] text-muted-foreground"><span className="size-1.5 rounded-full bg-muted-foreground/50" />Offline</span>
  return <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[11px]">{working(record) ? <Spinner className="size-3 text-amber-600" /> : <span className={`size-1.5 rounded-full ${record.status === 'failed' ? 'bg-amber-500' : 'bg-emerald-500'}`} />}{statusLabel(record)}</span>
}
const startsIn = (command) => STARTS.find((s) => s.id === command)?.name ?? command

export function TemplatesView() {
  const api = useApi()
  const compute = useCompute()
  const { templates: records, locations, error, refresh: load, loading } = useInventory()
  const [query, setQuery] = React.useState('')
  const [locationFilter, setLocationFilter] = React.useState('')
  const [defaultContext, setDefaultContext] = React.useState(null)
  const [editor, setEditor] = React.useState(null)
  const draftKey = editor ? pendingRecipeKey(locationKey(editor.location)) : null
  const [selectedKey, setSelectedKey] = React.useState(null)
  const [chooseLocation, setChooseLocation] = React.useState(false)
  const [pendingGateway, setPendingGateway] = React.useState(null)
  const restoredDraft = React.useRef(false)
  const [remove, setRemove] = React.useState(null)
  const [launch, setLaunch] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const deleting = React.useRef(false)
  const [checked, setChecked] = React.useState(() => new Set())
  const [deleteErrors, setDeleteErrors] = React.useState([])
  React.useEffect(() => {
    let current = true
    api.contextKey().then((context) => { if (current) setDefaultContext(JSON.stringify([api.target, context])) }).catch((e) => toast.error(e.message))
    return () => { current = false }
  }, [api])
  React.useEffect(() => {
    if (restoredDraft.current || !defaultContext) return
    const location = locations.find((location) => locationKey(location) === defaultContext)
    if (!location?.connected) return
    restoredDraft.current = true
    const draft = pendingRecipe(pendingRecipeKey(locationKey(location)))
    if (draft) setEditor((current) => current ?? { ...draft, location })
  }, [defaultContext, locations])
  const selected = records.find((t) => resourceKey(t) === selectedKey)
  const owner = (t) => locations.find((location) => locationKey(location) === locationKey(t.location)) ?? t.location
  // Location filtering narrows the table; every row always shows its source.
  const multipleLocations = locations.length > 1
  const connected = (t) => owner(t).connected !== false
  const scopedApi = (t) => {
    if (!connected(t)) throw new Error(`${locationLabel(owner(t))} is disconnected. Reconnect before continuing.`)
    return createApi(compute?.localViewer ? owner(t).target ?? "local" : api.target, api.signal, t.location.context)
  }
  const shown = records.filter((t) => (!multipleLocations || !locationFilter || locationKey(t.location) === locationFilter) && `${t.name} ${t.image || ''} ${t.recipe.repository || ''}`.toLowerCase().includes(query.toLowerCase()))
  const selectable = shown.filter((t) => !working(t) && connected(t))
  const checkedRecords = records.filter((t) => checked.has(resourceKey(t)) && !working(t) && connected(t))
  const matchingChecked = selectable.filter((t) => checked.has(resourceKey(t))).length
  const allChecked = selectable.length > 0 && matchingChecked === selectable.length
  React.useEffect(() => {
    const available = new Set(records.filter((t) => !working(t) && (locations.find((location) => locationKey(location) === locationKey(t.location)) ?? t.location).connected !== false).map(resourceKey))
    setChecked((current) => new Set([...current].filter((key) => available.has(key))))
  }, [records, locations])
  function toggle(key) {
    setChecked((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next })
  }
  function toggleMatching() {
    setChecked((current) => {
      const next = new Set(current)
      for (const t of selectable) { if (allChecked) next.delete(resourceKey(t)); else next.add(resourceKey(t)) }
      return next
    })
  }
  async function checkUsage(targets) {
    const failures = []
    for (const t of targets) {
      try {
        const usage = await scopedApi(t).imageTemplateUsage(t.name)
        if (usage.sandboxes.length) failures.push({ target: t, message: 'This template cannot be deleted while sandboxes use it.', sandboxes: usage.sandboxes })
      } catch (e) { failures.push({ target: t, message: e.message }) }
    }
    setDeleteErrors(failures)
  }
  async function askRemove(targets) {
    if (deleting.current) return
    deleting.current = true
    setBusy(true)
    setDeleteErrors([])
    setSelectedKey(null)
    setRemove(targets)
    try { await checkUsage(targets) } finally { deleting.current = false; setBusy(false) }
  }
  async function deleteUsingSandbox(target, name) {
    if (deleting.current) return
    deleting.current = true
    setBusy(true)
    try {
      await scopedApi(target).lifecycle(name, 'delete')
      toast.success(`Deleted sandbox ${name}`)
      await checkUsage(remove)
      await load()
    } catch (e) { toast.error(e.message) }
    finally { deleting.current = false; setBusy(false) }
  }
  async function deleteTemplates() {
    if (deleting.current || !remove?.length) return
    deleting.current = true
    setBusy(true)
    setDeleteErrors([])
    const succeeded = new Set(), failures = [], retained = new Map()
    try {
      for (const t of remove) {
        try {
          const result = await scopedApi(t).deleteImageTemplate(t.name)
          succeeded.add(resourceKey(t))
          const cleanup = result?.imageCleanup
          const imageKey = JSON.stringify([locationKey(t.location), cleanup?.image])
          if (cleanup?.status === 'retained') retained.set(imageKey, { image: cleanup.image, reason: cleanup.reason, location: owner(t) })
          else if (cleanup?.image) retained.delete(imageKey)
        }
        catch (e) { failures.push({ target: t, message: e.message, sandboxes: e.sandboxes }) }
      }
      for (const { image, reason, location } of retained.values()) toast.warning(reason, { description: `${locationLabel(location)} · ${image}`, duration: 10000 })
      setChecked((current) => new Set([...current].filter((key) => !succeeded.has(key))))
      setSelectedKey((key) => succeeded.has(key) ? null : key)
      setDeleteErrors(failures)
      if (succeeded.size) toast.success(`Deleted ${succeeded.size} ${succeeded.size === 1 ? 'template' : 'templates'}`)
      setRemove(failures.length ? remove.filter((t) => !succeeded.has(resourceKey(t))) : null)
      await load()
    } finally { deleting.current = false; setBusy(false) }
  }
  function edit(target, recipe, replace) {
    if (!connected(target)) return
    setSelectedKey(null)
    setEditor({ recipe, replace, location: owner(target) })
  }
  function startTemplate(location) {
    if (!location?.connected) return
    const draft = pendingRecipe(pendingRecipeKey(locationKey(location)))
    setEditor({ ...(draft ?? {}), location })
    setChooseLocation(false)
  }
  // A just-connected host shows up in the inventory a moment later; continue as soon as it does.
  React.useEffect(() => {
    if (!pendingGateway) return
    const found = locations.find((item) => item.gateway === pendingGateway && item.connected)
    if (found) { setPendingGateway(null); startTemplate(found); return }
    const timer = setInterval(load, 1500)
    return () => clearInterval(timer)
  }, [pendingGateway, locations])
  function closeEditor() { try { sessionStorage.removeItem(draftKey) } catch {} setEditor(null) }
  async function run(task) { try { await task(); await load() } catch (e) { toast.error(e.message) } }
  return <div className="h-[calc(100svh-3.5rem)] overflow-y-auto">
    {editor && <LocationProvider location={owner(editor)}><ImageTemplateBuilder key={JSON.stringify([locationKey(editor.location), editor.recipe?.name || 'new'])} initial={editor} draftKey={draftKey} onClose={closeEditor} onChangeLocation={editor.replace ? undefined : () => { setEditor(null); setChooseLocation(true) }} onStarted={(record) => { setSelectedKey(resourceKey({ ...record, location: editor.location })); closeEditor(); load() }} /></LocationProvider>}
    <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3 sm:px-6">
      <SearchInput aria-label="Search image templates" value={query} onValueChange={setQuery} placeholder="Search…" className="mr-auto min-w-32 flex-1 sm:max-w-60" />
      {multipleLocations && <SelectField aria-label="Filter template location" value={locationFilter} onChange={(e) => setLocationFilter(e.target.value)} className="h-8 rounded-md border bg-card px-2 text-xs">
        <option value="">All locations</option>
        {locations.map((location) => <option key={locationKey(location)} value={locationKey(location)}>{locationLabel(location)}{locationKey(location) === defaultContext ? ' (default)' : ''}{location.connected === false ? ' · disconnected' : ''}</option>)}
      </SelectField>}
      <Button size="sm" className={action} onClick={() => setChooseLocation(true)}><Plus />New template</Button>
    </div>
    {checkedRecords.length > 0 && <div className="flex flex-wrap items-center gap-3 border-b bg-accent/30 px-4 py-2 sm:px-6">
      <span role="status" className="mr-auto text-xs">{checkedRecords.length} selected{checkedRecords.length > matchingChecked && <span className="text-muted-foreground"> · {checkedRecords.length - matchingChecked} outside current filters</span>}</span>
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => setChecked(new Set())}>Clear selection</Button>
      <Button variant="destructive" size="sm" disabled={busy} onClick={() => askRemove(checkedRecords)}><Trash2 />Delete selected</Button>
    </div>}
    {error && <div role="alert" className="px-4 py-4 text-xs sm:px-6"><p>{error}</p><Button variant="outline" size="sm" className="mt-3" onClick={load}>Try again</Button></div>}
    {loading && !records.length ? <div role="status" className="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground"><Spinner />Loading…</div>
      : !shown.length ? <div className="py-12 text-center text-xs text-muted-foreground">
        <p>{records.length ? 'No matching templates.' : 'No image templates yet.'}</p>
        {query && <Button variant="ghost" size="sm" className="mt-2" onClick={() => setQuery('')}>Clear search</Button>}
      </div>
      : <BlurFade duration={0.15} offset={0} blur="0px">
        <div className="overflow-x-auto">
          <table aria-label="Image templates" className="w-full min-w-[580px] text-left">
            <thead className="border-b text-[11px] text-muted-foreground">
              <tr><th className="w-10 px-4 py-2 sm:pl-6"><Checkbox aria-label="Select all matching templates" checked={allChecked} indeterminate={matchingChecked > 0 && !allChecked} disabled={busy || !selectable.length} onCheckedChange={toggleMatching} /></th><th className="px-4 py-2 font-normal">Name</th><th className="px-4 py-2 font-normal">Source</th><th className="px-4 py-2 font-normal">Starts in</th><th className="px-4 py-2 font-normal">Image</th><th className="px-4 py-2 font-normal">Status</th><th className="px-4 py-2"><span className="sr-only">Actions</span></th></tr>
            </thead>
            <tbody className="divide-y">{shown.map((t) => <tr key={resourceKey(t)} className={checked.has(resourceKey(t)) ? "bg-accent/40 hover:bg-muted/40" : "hover:bg-muted/40"}>
              <td className="px-4 py-2 sm:pl-6"><Checkbox aria-label={`Select ${t.name} in ${locationLabel(owner(t))}`} checked={checked.has(resourceKey(t))} disabled={busy || working(t) || !connected(t)} onCheckedChange={() => toggle(resourceKey(t))} /></td>
              <td className="max-w-72 px-4 py-2">
                <button className="group flex max-w-full items-center gap-2 rounded text-left font-mono text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setSelectedKey(resourceKey(t))}><span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center rounded-lg border bg-muted/40 text-muted-foreground"><HardDrive className="size-4" strokeWidth={1.5} /></span><span className="truncate group-hover:underline">{t.name}</span></button>
              </td>
              <td className="px-4 py-2"><PlacementBadge location={owner(t)} /></td>
              <td className="px-4 py-2 text-[11px] text-muted-foreground">{t.managed === false ? '-' : startsIn(t.recipe.command)}</td>
              <td className="px-4 py-2"><span className="block max-w-64 truncate font-mono text-[11px] text-muted-foreground" title={t.image || ''}>{t.image || (t.recipe.source === 'image' ? t.recipe.image : 'Not built yet')}</span></td>
              <td className="px-4 py-2"><Status record={t} /></td>
              <td className="px-4 py-2 text-right sm:pr-6"><div className="flex items-center justify-end gap-1">
                {!working(t) && (t.status === 'failed' || (t.status === 'ready' && t.managed)) && <Button variant="ghost" size="xs" disabled={!connected(t)} aria-label={`Edit ${t.name} in ${locationLabel(owner(t))}`} onClick={() => edit(t, t.recipe, t.status === 'ready' || Boolean(t.exists))}><Pencil />Edit</Button>}
                <Button variant="ghost" size="xs" disabled={launchable(t) && !connected(t)} onClick={() => launchable(t) ? setLaunch(t) : setSelectedKey(resourceKey(t))}>{launchable(t) ? 'Use template' : working(t) ? 'View progress' : 'Details'}<ArrowRight /></Button>
                <Button variant="ghost" size="icon-sm" aria-label={`Delete ${t.name} in ${locationLabel(owner(t))}`} title={working(t) ? "Cancel the build before deleting this template" : `Delete ${t.name}`} disabled={busy || working(t) || !connected(t)} onClick={() => askRemove([t])}><Trash2 /></Button>
              </div></td>
            </tr>)}</tbody>
          </table>
        </div>
      </BlurFade>}
    <Dialog open={Boolean(selected)} onOpenChange={(open) => { if (!open) setSelectedKey(null) }}><DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-2xl">
      {selected && <><DialogHeader><DialogTitle className="font-mono">{selected.name}</DialogTitle><DialogDescription>{selected.managed === false ? 'Created outside the console. Edit it with the openshell CLI.' : 'OpenShell sandbox template'}</DialogDescription></DialogHeader><div className="flex items-center gap-3"><LocationBadge location={owner(selected)} /><Status record={selected} /></div>
        {!connected(selected) && <p role="status" className="text-xs text-muted-foreground">This location is disconnected. Reconnect to use or change this template.</p>}
        <dl className="divide-y rounded-lg border px-4 text-xs">{[
          ['Image', <span key="i" className="break-all font-mono">{selected.image || (selected.recipe.source === 'image' ? selected.recipe.image : 'Not built yet')}</span>],
          ...(selected.managed === false ? [] : [['Starts in', startsIn(selected.recipe.command)]]),
          ...(selected.recipe.source === 'build' && selected.managed !== false ? [
            ['Agents', [...selected.recipe.agents.map((id) => AGENTS.find((a) => a.id === id)?.name), ...(selected.recipe.customAgents ?? []).map((a) => a.name)].join(', ') || 'None'],
            ['Repository', selected.recipe.repository ? <span key="r" className="break-all font-mono">{selected.recipe.repository}</span> : 'None'],
          ] : []),
          ['Environment', selected.recipe.environment.length ? <span key="e" className="font-mono">{selected.recipe.environment.map((e) => e.name).join(', ')}</span> : 'None'],
          ['CLI', <code key="c" className="font-mono">openshell sandbox create --template {selected.name}</code>],
        ].map(([label, value]) => <div key={label} className="flex gap-4 py-2"><dt className="w-24 shrink-0 text-muted-foreground">{label}</dt><dd className="min-w-0">{value}</dd></div>)}</dl>
        {selected.error && <p role="alert" className="whitespace-pre-wrap rounded-md border border-amber-200 bg-amber-50/50 p-3 text-xs text-amber-800">{selected.error}</p>}
        {selected.logs && <details open={working(selected) || selected.status === 'failed'} className="overflow-hidden rounded-lg border"><summary className="cursor-pointer bg-muted/35 px-3 py-2 text-xs">Build log</summary><pre aria-label="Build log" className="max-h-64 overflow-auto whitespace-pre-wrap break-all bg-card p-4 font-mono text-[10px] leading-relaxed">{selected.logs}</pre></details>}
        <div className="flex flex-wrap items-center gap-2 border-t pt-4">{working(selected)
          ? <Button variant="outline" disabled={!connected(selected)} onClick={() => run(() => scopedApi(selected).cancelImageBuild(selected.name))}><X />Cancel build</Button>
          : <>
            {selected.status === 'failed' && <Button variant="outline" size="sm" disabled={!connected(selected)} onClick={() => edit(selected, selected.recipe, Boolean(selected.exists))}><RotateCw />Edit and retry</Button>}
            {selected.status === 'failed' && selected.exists && <Button variant="ghost" size="sm" disabled={!connected(selected)} onClick={() => run(() => scopedApi(selected).dismissImageBuild(selected.name))}>Dismiss</Button>}
            {selected.status === 'ready' && selected.managed && <Button variant="ghost" size="sm" disabled={!connected(selected)} onClick={() => edit(selected, selected.recipe, true)}><Pencil />Edit</Button>}
            {selected.managed !== false && <Button variant="ghost" size="sm" disabled={!connected(selected)} onClick={() => edit(selected, { ...selected.recipe, name: `${selected.name.slice(0, 14)}-copy` }, false)}><Copy />Duplicate</Button>}
            <Button variant="ghost" size="icon-sm" aria-label="Delete image template" disabled={busy || !connected(selected)} onClick={() => askRemove([selected])}><Trash2 /></Button>
            {launchable(selected) && <Button className={`ml-auto ${action}`} disabled={!connected(selected)} onClick={() => { setLaunch(selected); setSelectedKey(null) }}>Use template<ArrowRight /></Button>}
          </>}</div>
      </>}
    </DialogContent></Dialog>
    <Dialog open={Boolean(remove)} onOpenChange={(open) => { if (!open && !deleting.current) setRemove(null) }}><DialogContent className="max-h-[85svh] overflow-y-auto">
      <DialogHeader><DialogTitle>Delete {remove?.length === 1 ? 'this template' : `${remove?.length ?? 0} templates`}?</DialogTitle><DialogDescription>The selected templates and their unused Docker images will be deleted in their owning locations. Templates used by existing sandboxes cannot be deleted. Images shared with other templates are kept.</DialogDescription></DialogHeader>
      <ul className="max-h-40 overflow-y-auto text-xs">{remove?.map((t) => <li key={resourceKey(t)} className="flex items-center gap-2 break-all py-1"><span className="font-mono">{t.name}</span><LocationBadge location={owner(t)} /></li>)}</ul>
      {deleteErrors.length > 0 && <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs">
        <p>Cannot delete {remove?.length === 1 ? 'this template' : 'these templates'}.</p>
        <ul className="mt-2 space-y-3">{deleteErrors.map((e) => <li key={resourceKey(e.target)}>
          <p><span className="font-mono">{e.target.name}</span> <LocationBadge location={owner(e.target)} />: {e.message}</p>
          {e.sandboxes?.length > 0 && <><p className="mt-1 text-muted-foreground">Delete the sandboxes below, then retry. Deleting a sandbox permanently removes its files.</p>
            <ul className="mt-2 space-y-2">{e.sandboxes.map((sandbox) => <li key={resourceKey({ ...sandbox, location: e.target.location })} className="flex items-center justify-between gap-3">
              <span className="break-all font-mono">{sandbox.name}</span>
              <Button variant="destructive" size="sm" disabled={busy || !connected(e.target)} aria-label={`Delete sandbox ${sandbox.name} in ${locationLabel(owner(e.target))}`} onClick={() => deleteUsingSandbox(e.target, sandbox.name)}><Trash2 />Delete sandbox</Button>
            </li>)}</ul></>}
        </li>)}</ul>
      </div>}
      <div className="flex justify-end gap-2"><Button variant="ghost" disabled={busy} onClick={() => setRemove(null)}>Cancel</Button><Button variant="destructive" disabled={busy || !remove?.some(connected)} onClick={deleteTemplates}>{busy && <Spinner />}{busy ? 'Deleting…' : deleteErrors.length ? 'Retry deletion' : remove?.length === 1 ? 'Delete template' : 'Delete templates'}</Button></div>
    </DialogContent></Dialog>
    <Dialog open={chooseLocation} onOpenChange={(open) => { setChooseLocation(open); if (!open) setPendingGateway(null) }}><DialogContent className="gap-4 bg-transparent p-0 ring-0 sm:max-w-3xl">
      <LocationStep locations={locations} allowRemote subject="template" connecting={Boolean(pendingGateway)}
        onPick={(context) => startTemplate(locations.find((location) => locationKey(location) === context))}
        onConnected={(job) => { setPendingGateway(job.gateway); load() }}
        onCancel={() => setChooseLocation(false)} />
    </DialogContent></Dialog>
    {launch && <LocationProvider location={owner(launch)}><CreateSandboxDialog open initialImageTemplate={launch} onOpenChange={(open) => { if (!open) setLaunch(null) }} onStarted={() => setLaunch(null)} /></LocationProvider>}
  </div>
}
