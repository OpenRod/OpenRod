import * as React from 'react'
import { ArrowRight, Copy, Plus, Search, Trash2, Upload, X } from 'lucide-react'
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
import { PENDING_RECIPE_KEY, newRecipe, pendingRecipe } from '@/lib/image-templates'

const action = 'bg-[var(--action)] text-[var(--action-foreground)] hover:bg-[var(--action)]/90'
const working = (t) => ['building', 'importing'].includes(t.status)
const statusLabel = { draft: 'Draft', building: 'Building', importing: 'Importing', available: 'Available locally', failed: 'Needs attention' }
function Status({ record }) {
  return <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[11px]">{working(record) ? <Spinner className="size-3 text-amber-600" /> : <span className={`size-1.5 rounded-full ${record.status === 'available' ? 'bg-emerald-500' : record.status === 'failed' ? 'bg-amber-500' : 'bg-stone-300'}`} />}{statusLabel[record.status] || record.status}</span>
}

export function TemplatesView() {
  const [tab, setTab] = React.useState('images')
  const [records, setRecords] = React.useState(null)
  const [error, setError] = React.useState('')
  const [query, setQuery] = React.useState('')
  const [editor, setEditor] = React.useState(pendingRecipe)
  const [selectedId, setSelectedId] = React.useState(null)
  const [remove, setRemove] = React.useState(null)
  const [launch, setLaunch] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const load = React.useCallback(async () => {
    try { setRecords(await api.imageTemplates()); setError('') } catch (e) { setError(e.message) }
  }, [])
  React.useEffect(() => { load() }, [load])
  const hasWork = records?.some(working)
  React.useEffect(() => { const timer = setInterval(() => { if (document.visibilityState === 'visible') load() }, hasWork ? 1200 : 5000); return () => clearInterval(timer) }, [hasWork, load])
  const selected = records?.find((t) => t.id === selectedId)
  const shown = (records || []).filter((t) => `${t.recipe.name} ${t.recipe.description} ${t.image || ''}`.toLowerCase().includes(query.toLowerCase()))
  const upsert = (record) => setRecords((list) => [record, ...(list || []).filter((r) => r.id !== record.id)])
  function start(recipe) { setEditor({ recipe: newRecipe(recipe) }) }
  async function duplicate(record) {
    setSelectedId(null)
    setEditor({ recipe: { ...record.recipe, name: `${record.recipe.name} copy`.slice(0, 80) } })
  }
  function closeEditor() { try { sessionStorage.removeItem(PENDING_RECIPE_KEY) } catch {} setEditor(null) }
  if (editor) return <ImageTemplateBuilder key={editor.id || 'new'} initial={editor} onClose={closeEditor} onSaved={upsert} onStarted={(record) => { upsert(record); closeEditor(); setSelectedId(record.id) }} />
  return <div className="h-[calc(100svh-3.5rem)] overflow-y-auto">
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
          <Button variant="outline" size="sm" onClick={() => start({ source: 'local' })}><Upload />Import image</Button>
          <Button size="sm" className={action} onClick={() => start()}><Plus />New template</Button>
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
                  <tr><th className="px-4 py-2 font-normal sm:pl-8">Name</th><th className="px-4 py-2 font-normal">Image</th><th className="px-4 py-2 font-normal">Status</th><th className="px-4 py-2"><span className="sr-only">Actions</span></th></tr>
                </thead>
                <tbody className="divide-y">{shown.map((t) => <tr key={t.id} className="hover:bg-muted/40">
                  <td className="max-w-72 px-4 py-2 sm:pl-8">
                    <button className="block max-w-full truncate rounded text-left text-xs font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring" onClick={() => t.status === 'draft' ? setEditor(t) : setSelectedId(t.id)}>{t.recipe.name || 'Untitled template'}</button>
                  </td>
                  <td className="px-4 py-2"><span className="block max-w-72 truncate font-mono text-[11px] text-muted-foreground" title={t.image || t.recipe.image || t.recipe.base}>{t.image || t.recipe.image || (t.recipe.source === 'wizard' ? t.recipe.base : 'Image archive')}</span></td>
                  <td className="px-4 py-2"><Status record={t} /></td>
                  <td className="px-4 py-2 text-right sm:pr-8"><Button variant="ghost" size="xs" onClick={() => t.status === 'available' ? setLaunch(t) : t.status === 'draft' ? setEditor(t) : setSelectedId(t.id)}>{t.status === 'available' ? 'Use template' : t.status === 'draft' ? 'Continue' : 'View progress'}<ArrowRight /></Button></td>
                </tr>)}</tbody>
              </table>
            </div>
          </BlurFade>}
      </TabsContent>
      <TabsContent value="security" className="m-0"><div className="border-b px-4 py-6 sm:px-8"><h2 className="text-lg font-semibold tracking-tight">The boundaries around your sandbox.</h2><p className="mt-2 max-w-2xl text-xs leading-relaxed text-muted-foreground">Reusable filesystem and network rules. A security preset does not install software or create an image. Shared security rules still apply.</p></div><SecurityPresetsView /></TabsContent>
    </Tabs>
    <Dialog open={Boolean(selected)} onOpenChange={(open) => { if (!open) setSelectedId(null) }}><DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-2xl">
      {selected && <><DialogHeader><DialogTitle>{selected.recipe.name || 'Untitled template'}</DialogTitle><DialogDescription>{selected.recipe.description || 'Local image template'}</DialogDescription></DialogHeader><Status record={selected} />
        {selected.inspection && <div className="space-y-2 rounded-lg border bg-muted/25 p-4 text-xs"><p className="break-all font-mono">{selected.image}</p><p className="text-muted-foreground">Linux / {selected.inspection.architecture} · {(selected.inspection.size / 1024 ** 2).toFixed(0)} MB · {selected.inspection.context}</p><p className="text-[11px] leading-relaxed text-muted-foreground">Image inspected. Sandbox runtime not tested. The image must be available to your gateway’s container engine.</p></div>}
        {selected.error && <p role="alert" className="whitespace-pre-wrap rounded-md border border-amber-200 bg-amber-50/50 p-3 text-xs text-amber-800">{selected.error}</p>}
        {selected.logs && <details open={working(selected) || selected.status === 'failed'} className="overflow-hidden rounded-lg border"><summary className="cursor-pointer bg-muted/35 px-3 py-2 text-xs">Build & import log</summary><pre aria-label="Build log" className="max-h-64 overflow-auto whitespace-pre-wrap break-all bg-card p-4 font-mono text-[10px] leading-relaxed">{selected.logs}</pre></details>}
        <div className="flex flex-wrap items-center gap-2 border-t pt-4">{working(selected) ? <Button variant="outline" onClick={async () => { try { await api.cancelImageBuild(selected.id); await load() } catch (e) { toast.error(e.message) } }}><X />Cancel operation</Button> : <><Button variant="ghost" size="sm" onClick={() => duplicate(selected)}><Copy />Duplicate</Button><Button variant="ghost" size="sm" onClick={() => { setEditor(selected); setSelectedId(null) }}>Edit recipe</Button><Button variant="ghost" size="icon-sm" aria-label="Remove image template" onClick={() => setRemove(selected)}><Trash2 /></Button>{selected.status === 'available' && <Button className={`ml-auto ${action}`} onClick={() => { setLaunch(selected); setSelectedId(null) }}>Use template<ArrowRight /></Button>}</>}</div>
      </>}
    </DialogContent></Dialog>
    <Dialog open={Boolean(remove)} onOpenChange={(open) => { if (!open) setRemove(null) }}><DialogContent><DialogHeader><DialogTitle>Remove this template?</DialogTitle><DialogDescription>The saved recipe will be removed. Its Docker image and existing sandboxes will stay on this computer.</DialogDescription></DialogHeader><div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setRemove(null)}>Keep template</Button><Button variant="destructive" disabled={busy} onClick={async () => { setBusy(true); try { await api.deleteImageTemplate(remove.id); setRemove(null); setSelectedId(null); await load() } catch (e) { toast.error(e.message) } finally { setBusy(false) } }}>{busy && <Spinner />}Remove template</Button></div></DialogContent></Dialog>
    <CreateSandboxDialog open={Boolean(launch)} initialImageTemplate={launch} onOpenChange={(open) => { if (!open) setLaunch(null) }} onCreated={() => { setLaunch(null); toast.success('Sandbox created from image template') }} />
  </div>
}
