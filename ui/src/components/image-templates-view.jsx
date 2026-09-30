import * as React from 'react'
import { ArrowRight, Copy, HardDrive, Pencil, Plus, RotateCw, Search, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { BlurFade } from '@/components/ui/blur-fade'
import { Spinner } from '@/components/ui/spinner'
import { SecurityPresetsView } from '@/components/templates-view'
import { ImageTemplateBuilder } from '@/components/image-template-builder'
import { CreateSandboxDialog } from '@/components/create-sandbox-dialog'
import { api } from '@/lib/api'
import { AGENTS, PENDING_RECIPE_KEY, STARTS, pendingRecipe } from '@/lib/image-templates'

const action = 'bg-[var(--action)] text-[var(--action-foreground)] hover:bg-[var(--action)]/90'
const working = (t) => t.status === 'building'
// A template stays usable while its rebuild runs or after a rebuild fails.
export const launchable = (t) => t.status === 'ready' || t.exists
const statusLabel = (t) => working(t) ? (t.exists ? 'Rebuilding' : 'Building') : t.status === 'failed' ? (t.exists ? 'Rebuild failed' : 'Build failed') : 'Ready'
function Status({ record }) {
  return <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[11px]">{working(record) ? <Spinner className="size-3 text-amber-600" /> : <span className={`size-1.5 rounded-full ${record.status === 'failed' ? 'bg-amber-500' : 'bg-emerald-500'}`} />}{statusLabel(record)}</span>
}
const startsIn = (command) => STARTS.find((s) => s.id === command)?.name ?? command

export function TemplatesView() {
  const [tab, setTab] = React.useState('images')
  const [records, setRecords] = React.useState(null)
  const [error, setError] = React.useState('')
  const [query, setQuery] = React.useState('')
  const [editor, setEditor] = React.useState(pendingRecipe)
  const [selectedName, setSelectedName] = React.useState(null)
  const [remove, setRemove] = React.useState(null)
  const [launch, setLaunch] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const load = React.useCallback(async () => {
    try { setRecords(await api.imageTemplates()); setError('') } catch (e) { setError(e.message) }
  }, [])
  React.useEffect(() => { load() }, [load])
  const hasWork = records?.some(working)
  React.useEffect(() => { const timer = setInterval(() => { if (document.visibilityState === 'visible') load() }, hasWork ? 1200 : 5000); return () => clearInterval(timer) }, [hasWork, load])
  const selected = records?.find((t) => t.name === selectedName)
  const shown = (records || []).filter((t) => `${t.name} ${t.image || ''} ${t.recipe.repository || ''}`.toLowerCase().includes(query.toLowerCase()))
  function edit(recipe, replace) { setSelectedName(null); setEditor({ recipe, replace }) }
  function closeEditor() { try { sessionStorage.removeItem(PENDING_RECIPE_KEY) } catch {} setEditor(null) }
  async function run(task) { try { await task(); await load() } catch (e) { toast.error(e.message) } }
  return <div className="h-[calc(100svh-3.5rem)] overflow-y-auto">
    {editor && <ImageTemplateBuilder key={editor.recipe?.name || 'new'} initial={editor} onClose={closeEditor} onStarted={(record) => { closeEditor(); setSelectedName(record.name); load() }} />}
    <Tabs value={tab} onValueChange={setTab} className="gap-0">
      <div className="border-b bg-card px-4 sm:px-8">
        <TabsList variant="line" className="h-11! gap-5 p-0">
          <TabsTrigger value="images" className="h-full px-0 text-xs after:bottom-0!">Image templates</TabsTrigger>
          <TabsTrigger value="security" className="h-full px-0 text-xs after:bottom-0!">Security presets</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="images" className="m-0">
        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3 sm:px-8">
          <div className="relative mr-auto min-w-32 flex-1 sm:max-w-60">
            <Search className="pointer-events-none absolute top-2.5 left-2.5 size-3.5 text-faint" />
            <Input aria-label="Search image templates" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search…" className="h-8 bg-card pl-8 text-xs" />
          </div>
          <Button size="sm" className={action} onClick={() => setEditor({})}><Plus />New template</Button>
        </div>
        {error ? <div role="alert" className="px-4 py-6 text-xs sm:px-8"><p>{error}</p><Button variant="outline" size="sm" className="mt-3" onClick={load}>Try again</Button></div>
          : records === null ? <div role="status" className="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground"><Spinner />Loading…</div>
          : !shown.length ? <div className="py-12 text-center text-xs text-muted-foreground">
            <p>{records.length ? 'No matching templates.' : 'No image templates yet.'}</p>
            {query && <Button variant="ghost" size="sm" className="mt-2" onClick={() => setQuery('')}>Clear search</Button>}
          </div>
          : <BlurFade duration={0.15} offset={0} blur="0px">
            <div className="overflow-x-auto">
              <table aria-label="Image templates" className="w-full min-w-[580px] text-left">
                <thead className="border-b text-[11px] text-muted-foreground">
                  <tr><th className="px-4 py-2 font-normal sm:pl-8">Name</th><th className="px-4 py-2 font-normal">Starts in</th><th className="px-4 py-2 font-normal">Image</th><th className="px-4 py-2 font-normal">Status</th><th className="px-4 py-2"><span className="sr-only">Actions</span></th></tr>
                </thead>
                <tbody className="divide-y">{shown.map((t) => <tr key={t.name} className="hover:bg-muted/40">
                  <td className="max-w-72 px-4 py-2 sm:pl-8">
                    <button className="group flex max-w-full items-center gap-2 rounded text-left font-mono text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setSelectedName(t.name)}><span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center rounded-lg border bg-muted/40 text-muted-foreground"><HardDrive className="size-4" strokeWidth={1.5} /></span><span className="truncate group-hover:underline">{t.name}</span></button>
                  </td>
                  <td className="px-4 py-2 text-[11px] text-muted-foreground">{t.managed === false ? '—' : startsIn(t.recipe.command)}</td>
                  <td className="px-4 py-2"><span className="block max-w-64 truncate font-mono text-[11px] text-muted-foreground" title={t.image || ''}>{t.image || (t.recipe.source === 'image' ? t.recipe.image : 'Not built yet')}</span></td>
                  <td className="px-4 py-2"><Status record={t} /></td>
                  <td className="px-4 py-2 text-right sm:pr-8"><Button variant="ghost" size="xs" onClick={() => launchable(t) ? setLaunch(t) : setSelectedName(t.name)}>{launchable(t) ? 'Use template' : working(t) ? 'View progress' : 'Details'}<ArrowRight /></Button></td>
                </tr>)}</tbody>
              </table>
            </div>
          </BlurFade>}
      </TabsContent>
      <TabsContent value="security" className="m-0"><SecurityPresetsView /></TabsContent>
    </Tabs>
    <Dialog open={Boolean(selected)} onOpenChange={(open) => { if (!open) setSelectedName(null) }}><DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-2xl">
      {selected && <><DialogHeader><DialogTitle className="font-mono">{selected.name}</DialogTitle><DialogDescription>{selected.managed === false ? 'Created outside the console. Edit it with the openshell CLI.' : 'OpenShell sandbox template'}</DialogDescription></DialogHeader><Status record={selected} />
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
          ? <Button variant="outline" onClick={() => run(() => api.cancelImageBuild(selected.name))}><X />Cancel build</Button>
          : <>
            {selected.status === 'failed' && <Button variant="outline" size="sm" onClick={() => edit(selected.recipe, Boolean(selected.exists))}><RotateCw />Edit and retry</Button>}
            {selected.status === 'failed' && selected.exists && <Button variant="ghost" size="sm" onClick={() => run(() => api.dismissImageBuild(selected.name))}>Dismiss</Button>}
            {selected.status === 'ready' && selected.managed && <Button variant="ghost" size="sm" onClick={() => edit(selected.recipe, true)}><Pencil />Edit</Button>}
            {selected.managed !== false && <Button variant="ghost" size="sm" onClick={() => edit({ ...selected.recipe, name: `${selected.name.slice(0, 14)}-copy` }, false)}><Copy />Duplicate</Button>}
            <Button variant="ghost" size="icon-sm" aria-label="Remove image template" onClick={() => setRemove(selected)}><Trash2 /></Button>
            {launchable(selected) && <Button className={`ml-auto ${action}`} onClick={() => { setLaunch(selected); setSelectedName(null) }}>Use template<ArrowRight /></Button>}
          </>}</div>
      </>}
    </DialogContent></Dialog>
    <Dialog open={Boolean(remove)} onOpenChange={(open) => { if (!open) setRemove(null) }}><DialogContent><DialogHeader><DialogTitle>Remove this template?</DialogTitle><DialogDescription>The OpenShell template is deleted. Its Docker image and existing sandboxes stay.</DialogDescription></DialogHeader><div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setRemove(null)}>Keep template</Button><Button variant="destructive" disabled={busy} onClick={async () => { setBusy(true); try { await api.deleteImageTemplate(remove.name); setRemove(null); setSelectedName(null); await load() } catch (e) { toast.error(e.message) } finally { setBusy(false) } }}>{busy && <Spinner />}Remove template</Button></div></DialogContent></Dialog>
    <CreateSandboxDialog open={Boolean(launch)} initialImageTemplate={launch} onOpenChange={(open) => { if (!open) setLaunch(null) }} onCreated={() => { setLaunch(null); toast.success('Sandbox created from image template') }} />
  </div>
}
