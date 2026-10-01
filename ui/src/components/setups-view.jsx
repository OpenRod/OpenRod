import { SETUP_AGENTS, setupTarget } from '../../shared/setup-targets.js'
import * as React from 'react'
import { ArrowDown, ArrowUp, Check, ChevronRight, FileText, FolderInput, Package, Plug, Plus, RefreshCw, Search, ShieldCheck, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { absoluteTime } from '@/lib/format'
import { Checkbox } from '@/components/ui/checkbox'
import { SelectField } from '@/components/ui/select-field'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from '@/components/ui/accordion'
import { BlurFade } from '@/components/ui/blur-fade'
import { Spinner } from '@/components/ui/spinner'
import { terminalHref } from '@/lib/sandbox-session'
import { api } from '@/lib/api'
import { importNeedsAttention } from '@/lib/import-setup'
import { setupImports } from '@/lib/setup-imports'
import { canPrepareAtLaunch, launchableItem, launchRequirements } from '../../shared/setup-launch.js'

const SOURCES = [{ id: 'codex', name: 'Codex', logo: 'codex' }, { id: 'claude', name: 'Claude Code', logo: 'claudecode' }, { id: 'cursor', name: 'Cursor', logo: 'cursor' }]
const count = (setup, kind) => setup.items.filter((item) => item.kind === kind).length
const readyCount = (setup) => setup.items.filter(item => !item.disabled && !item.issues.length).length
const issueCount = (setup) => setup.items.filter((item) => item.issues.length).length
function ErrorMessage({ children }) { return children ? <p role="alert" className="rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-xs text-destructive">{children}</p> : null }
function Note({ children }) { return <div className="flex gap-2 rounded-lg border bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground"><ShieldCheck className="mt-0.5 size-3.5 shrink-0" /><span>{children}</span></div> }

const ITEM_KINDS = [
  { kind: 'mcp', label: 'MCPs', icon: Plug },
  { kind: 'skill', label: 'Skills', icon: FileText },
]

function SetupItemTabs({ items, children }) {
  return <Tabs defaultValue={items.some(item => item.kind === 'mcp') ? 'mcp' : 'skill'} className="min-w-0 gap-3">
    <TabsList aria-label="Setup item categories" className="w-full">
      {ITEM_KINDS.map(({ kind, label, icon: Icon }) => <TabsTrigger key={kind} value={kind} className="gap-2 text-xs">
        <Icon className="size-3.5" />{label}<span className="rounded bg-foreground/5 px-1.5 text-[10px] tabular-nums text-muted-foreground">{items.filter(item => item.kind === kind).length}</span>
      </TabsTrigger>)}
    </TabsList>
    {ITEM_KINDS.map(({ kind, label, icon: Icon }) => <TabsContent key={kind} value={kind} keepMounted className="min-w-0">
      <BlurFade duration={0.16} offset={2} blur="0px">
        {items.some(item => item.kind === kind) ? children(items.filter(item => item.kind === kind)) : <div className="rounded-lg border border-dashed px-4 py-8 text-center">
          <Icon className="mx-auto mb-2 size-5 text-muted-foreground" strokeWidth={1.5} />
          <p className="text-xs text-muted-foreground">No {label} in this setup.</p>
        </div>}
      </BlurFade>
    </TabsContent>)}
  </Tabs>
}

export function SetupsView({ sandbox = null, setupIds = [] }) {
  const [setups, setSetups] = React.useState(null)
  const [error, setError] = React.useState('')
  const [importing, setImporting] = React.useState(false)
  const [selected, setSelected] = React.useState(null)
  const [deleting, setDeleting] = React.useState(null)
  const [deleteBusy, setDeleteBusy] = React.useState(false)
  const [deleteError, setDeleteError] = React.useState('')
  const [query, setQuery] = React.useState('')
  const [status, setStatus] = React.useState('all')
  const [descending, setDescending] = React.useState(false)
  const [refreshing, setRefreshing] = React.useState(false)
  const refresh = React.useCallback(async () => {
    setRefreshing(true)
    try { setSetups(await api.setups()); setError('') } catch (e) { setError(e.message) }
    finally { setRefreshing(false) }
  }, [])
  const importJobs = React.useSyncExternalStore(setupImports.subscribe, setupImports.getSnapshot)
  const completedImports = importJobs.filter(job => job.status === 'saved').map(job => job.id).join(',')
  React.useEffect(() => { refresh() }, [refresh, completedImports])
  const shown = React.useMemo(() => (setups || []).filter((setup) => {
    const matches = [setup.name, ...setup.items.flatMap(item => [item.name, ...(item.sources || [])])].join(' ').toLowerCase().includes(query.trim().toLowerCase())
    return (!sandbox || setupIds.includes(setup.id)) && matches && (status === 'all' || (status === 'review' ? issueCount(setup) > 0 : issueCount(setup) === 0))
  }).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }) * (descending ? -1 : 1)), [setups, query, status, descending, sandbox, setupIds])
  const filtering = Boolean(query || status !== 'all')
  return <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
    <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3 sm:px-8">
      <div className="relative mr-auto min-w-32 flex-1 sm:max-w-60">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" />
        <Input aria-label="Search setups" placeholder="Search…" value={query} onChange={e => setQuery(e.target.value)} className="h-8 bg-card pl-8 text-xs" />
      </div>
      <SelectField aria-label="Filter setups by status" value={status} onChange={e => setStatus(e.target.value)} className="h-8 w-36 bg-card text-xs">
        <option value="all">All statuses</option><option value="imported">Imported</option><option value="review">Needs review</option>
      </SelectField>
      {filtering && <Button variant="ghost" size="sm" onClick={() => { setQuery(''); setStatus('all') }}>Clear</Button>}
      <Button variant="ghost" size="icon-sm" aria-label="Refresh setups" disabled={refreshing} onClick={refresh}>{refreshing ? <Spinner className="size-3.5" /> : <RefreshCw className="size-3.5" />}</Button>
      <Button size="sm" className="bg-[var(--action)] text-[var(--action-foreground)] hover:bg-[var(--action)]/90" onClick={() => setImporting(true)}><Plus />Bring my setup</Button>
    </div>
    {error && <div className="space-y-2 border-b px-4 py-3 sm:px-8"><ErrorMessage>{error}</ErrorMessage><Button variant="outline" size="sm" disabled={refreshing} onClick={refresh}>Try again</Button></div>}
    <div className="flex-1">
      {!setups && !error ? <div role="status" className="flex items-center justify-center gap-2 py-12 text-xs text-muted-foreground"><Spinner />Loading setups…</div>
        : setups && !shown.length ? <div className="px-4 py-16 text-center">
          <FolderInput className="mx-auto mb-3 size-6 text-muted-foreground" strokeWidth={1.5} />
          <p className="text-sm font-medium">{sandbox && !filtering ? 'No setups in this sandbox' : setups.length ? 'No matching setups' : 'No setups yet'}</p>
          <p className="mt-2 text-xs text-muted-foreground">{sandbox && !filtering ? 'Choose a setup from MCPs & Skills to enable it here.' : setups.length ? 'Try another name, tool, source agent, or status.' : 'Import MCPs and Skills from Codex, Claude Code, or Cursor.'}</p>
          {(!sandbox || filtering) && <Button variant="outline" size="sm" className="mt-4" onClick={() => setups.length ? (setQuery(''), setStatus('all')) : setImporting(true)}>{setups.length ? 'Clear filters' : 'Bring my setup'}</Button>}
        </div>
        : setups && <BlurFade duration={0.15} offset={0} blur="0px">
          <Table aria-label="MCPs & Skills" className="min-w-[740px] text-xs">
            <TableHeader><TableRow className="hover:bg-transparent">
              <TableHead scope="col" aria-sort={descending ? 'descending' : 'ascending'} className="h-9 px-4 text-[11px] font-normal text-muted-foreground sm:pl-8"><button className="flex items-center gap-1.5 rounded outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setDescending(value => !value)}>Name{descending ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />}</button></TableHead>
              {['Source agents', 'MCPs', 'Skills', 'Created'].map(label => <TableHead key={label} scope="col" className="h-9 px-4 text-[11px] font-normal text-muted-foreground">{label}</TableHead>)}
              <TableHead className="w-12"><span className="sr-only">Actions</span></TableHead>
            </TableRow></TableHeader>
            <TableBody>{shown.map(setup => {
              const sources = SOURCES.filter(source => setup.items.some(item => item.sources?.includes(source.id)))
              return <TableRow key={setup.id} className="cursor-pointer hover:bg-muted/40" onClick={() => setSelected(setup)}>
                <TableCell className="max-w-72 px-4 py-2 sm:pl-8"><button aria-label={`Open setup ${setup.name}`} onClick={event => { event.stopPropagation(); setSelected(setup) }} className="group flex max-w-full items-center gap-2 rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-lg border bg-muted/40 text-muted-foreground"><Package className="size-3.5" strokeWidth={1.5} /></span>
                  <span className="truncate font-mono text-xs font-medium group-hover:underline">{setup.name}</span>
                </button></TableCell>
                <TableCell className="px-4 py-2"><div className="flex items-center gap-2">{sources.map(source => <img key={source.id} src={`/logos/agents/${source.logo}.svg`} alt={source.name} title={source.name} className="size-4 object-contain" />)}{!sources.length && <span className="text-muted-foreground">Not reported</span>}</div></TableCell>
                <TableCell className="px-4 py-2 tabular-nums"><span className="inline-flex items-center gap-1.5"><Plug aria-hidden="true" className="size-3.5 text-muted-foreground" strokeWidth={1.5} />{count(setup, 'mcp')}</span></TableCell>
                <TableCell className="px-4 py-2 tabular-nums"><span className="inline-flex items-center gap-1.5"><FileText aria-hidden="true" className="size-3.5 text-muted-foreground" strokeWidth={1.5} />{count(setup, 'skill')}</span></TableCell>
                <TableCell className="px-4 py-2 text-[11px] text-muted-foreground">{setup.createdAt ? absoluteTime(setup.createdAt) : 'Not reported'}</TableCell>
                <TableCell className="px-4 py-2 text-right sm:pr-8"><Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-destructive" aria-label={`Delete setup ${setup.name}`} onClick={event => { event.stopPropagation(); setDeleteError(''); setDeleting(setup) }}><Trash2 className="size-3.5" /></Button></TableCell>
              </TableRow>
            })}</TableBody>
          </Table>
        </BlurFade>}
    </div>
    <div className="flex flex-wrap items-center justify-between gap-2 border-t bg-card px-4 py-2 text-[11px] text-muted-foreground sm:px-8"><span><strong className="font-medium text-foreground">{shown.length}</strong>{filtering ? ` of ${setups?.length || 0}` : ''} {setups?.length === 1 ? 'setup' : 'setups'}</span><span>Saved locally · Available in templates and sandboxes</span></div>
    {deleting && <Dialog open onOpenChange={(open) => { if (!open && !deleteBusy) setDeleting(null) }}><DialogContent className="sm:max-w-md"><DialogHeader><DialogTitle>Delete “{deleting.name}”?</DialogTitle><DialogDescription>This deletes the saved setup and its imported rows. Tools already installed in sandboxes or built images stay in place. Templates using this setup will need a different setup selected before reuse.</DialogDescription></DialogHeader><ErrorMessage>{deleteError}</ErrorMessage><div className="flex justify-end gap-2"><Button variant="ghost" disabled={deleteBusy} onClick={() => setDeleting(null)}>Cancel</Button><Button variant="destructive" disabled={deleteBusy} onClick={async () => {
      setDeleteBusy(true); setDeleteError('')
      try {
        await api.deleteSetup(deleting.id, deleting.revision)
        setSetups((current) => current.filter((entry) => entry.id !== deleting.id))
        setSelected((current) => current?.id === deleting.id ? null : current)
        setDeleting(null)
      } catch (e) { setDeleteError(e.message) } finally { setDeleteBusy(false) }
    }}>{deleteBusy && <Spinner />}Delete setup</Button></div></DialogContent></Dialog>}
    {importing && <ImportSetup initialReview={importing.review} initialName={importing.name} onClose={() => setImporting(false)} onSaved={() => { setImporting(false); refresh() }} />}
    {selected && <SetupDetail setup={selected} sandbox={sandbox} onPrepare={async () => { try { const review = await api.prepareSavedSetup(selected.id); setImporting({ review, name: selected.name + " (updated)" }); setSelected(null) } catch (e) { setError(e.message) } }} onUpdated={(updated) => { setSelected(updated); setSetups((current) => current.map((entry) => entry.id === updated.id ? updated : entry)) }} onClose={() => setSelected(null)} />}
  </div>
}

export function SetupImportNotifications() {
  const jobs = React.useSyncExternalStore(setupImports.subscribe, setupImports.getSnapshot)
  const [reviewing, setReviewing] = React.useState(null)
  return <>
    {jobs.length > 0 && <div aria-label="Import notifications" className="shrink-0 divide-y border-b bg-muted/30">
      {jobs.map(job => <div key={job.id} role={job.status === 'failed' || job.status === 'needs-attention' ? 'alert' : 'status'} className="flex items-center gap-3 px-4 py-3 text-xs sm:px-8">
        {job.status === 'importing' ? <Spinner /> : job.status === 'saved' ? <Check className="size-4 shrink-0 text-emerald-600" /> : <ShieldCheck className="size-4 shrink-0 text-amber-600" />}
        <div className="min-w-0 flex-1"><p className="font-medium">{job.name} · {job.status === 'importing' ? 'Importing' : job.status === 'saved' ? 'Imported' : job.status === 'cancelled' ? 'Import cancelled' : 'Import needs attention'}</p><p className="mt-0.5 break-words text-muted-foreground">{job.message}</p></div>
        {!['importing', 'saved'].includes(job.status) && <Button size="sm" variant="outline" onClick={() => setReviewing(job)}>Review import</Button>}
        {job.status !== 'importing' && <Button size="sm" variant="ghost" aria-label={`Dismiss import notification for ${job.name}`} onClick={() => setupImports.dismiss(job.id)}>Dismiss</Button>}
      </div>)}
    </div>}
    {reviewing && <ImportSetup key={reviewing.id} initialJob={reviewing} initialReview={reviewing.review} initialName={reviewing.name} onClose={() => setReviewing(null)} onSaved={() => setReviewing(null)} />}
  </>
}

function ImportSetup({ onClose, onSaved, initialReview = null, initialName = "My setup", initialJob = null }) {
  const [sources, setSources] = React.useState([])
  const [scan, setScan] = React.useState(null)
  const [ids, setIds] = React.useState([])
  const [review, setReview] = React.useState(initialReview)
  const [name, setName] = React.useState(initialName)
  const [query, setQuery] = React.useState('')
  const [file, setFile] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  async function run(task) { setBusy(true); setError(''); try { await task() } catch (e) { setError(e.message) } finally { setBusy(false) } }
  const [choices, setChoices] = React.useState({})
  const [preparation, setPreparation] = React.useState(initialJob?.preparation ?? null)
  const [preparedReview, setPreparedReview] = React.useState(initialJob?.prepared ?? false)
  const [finalImport, setFinalImport] = React.useState(false)
  const jobId = React.useRef(initialJob?.id)
  const mounted = React.useRef(true)
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const preparing = preparation?.status === 'running' || (busy && Boolean(preparation))
  const choose = (id, update) => { setPreparedReview(false); setChoices(old => ({ ...old, [id]: { ...old[id], ...update } })) }
  async function importSelection(saveOnly = false) {
    setFinalImport(true)
    const task = setupImports.start({ id: jobId.current, review, name, choices, saveOnly,
      resumeJob: preparation?.status === 'running' ? preparation : undefined,
    }, {
      onProgress: next => { if (mounted.current) setPreparation(next) },
      onReview: next => { if (mounted.current) { setReview(next); setPreparedReview(true); setChoices({}) } },
    })
    jobId.current = task.id
    try {
      const result = await task.promise
      if (!mounted.current) return
      if (result.status === 'saved') onSaved()
      else if (result.status === 'needs-attention') setError('Some items need attention. Update them and retry, or import this setup with those items inactive.')
      else { setPreparedReview(false); setError('Import cancelled. Completed preparation is kept here for retry.') }
    } finally { if (mounted.current) setFinalImport(false) }
  }
  const items = scan?.items.filter((item) => `${item.name} ${item.kind} ${item.sources.join(' ')}`.toLowerCase().includes(query.toLowerCase())) ?? []
  const selectedIds = new Set(ids)
  const selectItems = (group, checked) => setIds((current) => {
    const next = new Set(current)
    for (const item of group) { if (checked) next.add(item.id); else next.delete(item.id) }
    return [...next]
  })
  const allVisibleSelected = items.length > 0 && items.every((item) => selectedIds.has(item.id))
  return <Dialog open onOpenChange={(open) => { if (!open && (jobId.current || finalImport || (!busy && !preparing))) onClose() }}>
    <DialogContent className="flex max-h-[90svh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
      <DialogHeader className="shrink-0 px-6 pb-4 pt-6 pr-12"><DialogTitle>{review ? 'Import setup' : scan ? 'Choose what to bring' : 'Bring my setup'}</DialogTitle><DialogDescription>{review ? 'Import prepares your tools, checks MCP connections, and saves your setup.' : scan ? 'Identical MCPs and skill copies are merged across sources. Different configurations or skill versions stay separate.' : 'Read selected harness configurations on the computer running this console. Your local setup stays unchanged.'}</DialogDescription></DialogHeader>
      <div className="min-h-0 space-y-5 overflow-y-auto px-6 pb-5">
      {!scan && !review && <>
        <div className="grid gap-2 sm:grid-cols-3">{SOURCES.map((s) => <button key={s.id} type="button" aria-pressed={sources.includes(s.id)} onClick={() => setSources((v) => v.includes(s.id) ? v.filter((x) => x !== s.id) : [...v, s.id])} className={`flex items-center gap-2 rounded-xl border px-3 py-4 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring ${sources.includes(s.id) ? 'border-ring bg-muted' : 'bg-card'}`}><span className="flex size-7 items-center justify-center rounded-lg border bg-muted/30"><img src={`/logos/agents/${s.logo}.svg`} alt="" className="size-4" /></span>{s.name}{sources.includes(s.id) && <Check className="ml-auto size-3.5" />}</button>)}</div>
        <Note>No credential stores, project folders or plugin code are scanned. No background sync. This scan runs here, not on another computer viewing the page.</Note>
      </>}
      {scan && !review && <>
        <div className="relative"><Search className="absolute left-3 top-2.5 size-3.5 text-muted-foreground" /><Input aria-label="Search discovered tools" className="pl-9 text-xs" placeholder="Search MCPs and Skills…" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
        <div className="flex items-center justify-between gap-3">
          <p role="status" className="text-xs text-muted-foreground">{ids.length} of {scan.items.length} selected{query.trim() ? ` · ${items.length} matching` : ''}</p>
          <Button size="sm" variant="outline" disabled={busy || !items.length} onClick={() => selectItems(items, !allVisibleSelected)}>{allVisibleSelected ? (query.trim() ? 'Clear results' : 'Clear all') : (query.trim() ? 'Select all results' : 'Select all')}</Button>
        </div>
        <div className="grid items-start gap-3 sm:grid-cols-2">
          {[{ kind: 'mcp', label: 'MCPs' }, { kind: 'skill', label: 'Skills' }].map(({ kind, label }) => {
            const group = items.filter((item) => item.kind === kind)
            const selected = group.filter((item) => selectedIds.has(item.id)).length
            const allSelected = group.length > 0 && selected === group.length
            return <section key={kind} aria-label={label} className="min-w-0 overflow-hidden rounded-xl border">
              <div className="flex items-center justify-between gap-3 border-b bg-muted px-3 py-2">
                <h3 className="text-xs font-medium">{label}<span className="ml-2 font-normal text-muted-foreground">{selected}/{group.length}</span></h3>
                <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={busy || !group.length} aria-label={`${allSelected ? 'Clear' : 'Select all'} ${label}${query.trim() ? ' in search results' : ''}`} onClick={() => selectItems(group, !allSelected)}>{allSelected ? 'Clear' : 'Select all'}</Button>
              </div>
              <div className="max-h-64 divide-y overflow-y-auto">{group.map((item) => <label key={item.id} className="flex cursor-pointer items-start gap-3 p-3"><Checkbox disabled={busy} aria-label={`Import ${item.name} from ${item.sources.join(', ')}`} checked={selectedIds.has(item.id)} onCheckedChange={(checked) => selectItems([item], checked)} /><span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium">{item.name}</span><span className="mt-1 block text-[11px] text-muted-foreground">{item.sources.join(', ')}{item.issues.length ? ' · Needs review' : ''}</span></span></label>)}{!group.length && <p className="p-4 text-xs text-muted-foreground">{query.trim() ? `No matching ${label}` : `No ${label} found`}</p>}</div>
            </section>
          })}
        </div>
        <p className="text-[11px] text-muted-foreground">{query.trim() ? 'Bulk selection applies to search results. Other selections are kept. ' : ''}Up to 8 MB per Setup; each Skill is checked during review.</p>
        {scan.warnings.map((warning) => <p key={warning} className="text-[11px] text-muted-foreground">{warning}</p>)}
      </>}
      {review && <>
        <label className="grid gap-1.5 text-xs">Setup name<Input disabled={busy} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></label>
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>{readyCount(review)} compatible · {issueCount(review)} need attention</span>
        </div>
        <SetupItemTabs items={review.items}>{(items) => <Accordion className="overflow-hidden rounded-lg border">{items.map((item) => <AccordionItem key={item.id} value={item.id}>
          <AccordionTrigger className="items-center gap-3 rounded-none px-3 py-3 text-xs hover:bg-muted/30 hover:no-underline">
            <span className="min-w-0 flex-1 break-words">{item.name}</span>
            <span className={`shrink-0 text-[11px] font-normal ${item.issues.length ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground'}`}>
              {item.disabled ? 'Inactive' : item.issues.length ? 'Needs attention' : item.kind === 'skill' ? `${item.files?.length ?? 0} files` : item.auth?.mode === 'agent-session' ? 'Sign-in needed' : item.verification?.status === 'connected' ? 'Connection checked' : item.artifact ? 'Prepared' : 'Not checked'}
            </span>
          </AccordionTrigger>
          <AccordionContent className="space-y-3 border-t bg-muted/10 px-4 py-4 text-xs leading-relaxed [&_p:not(:last-child)]:mb-0">
            {item.issues.length > 0 && <div className="space-y-1 text-amber-700 dark:text-amber-400">{item.issues.map(issue => <p key={issue}>{issue}</p>)}</div>}
            {item.requirements.map((r, i) => <p key={i}><span className="font-medium">{r.phase === 'build' ? 'Build' : r.phase === 'auth' ? 'Sign-in' : 'Runtime'}:</span> {r.host}:{r.port} · {r.reason}</p>)}
            {item.kind === 'skill' && <p className="text-muted-foreground">Scripts are copied, never run during import. Runtime destinations are unknown and remain subject to sandbox policy.</p>}
            {item.package && <p>Package: {item.package.name}@{item.artifact?.version || item.package.requested}{item.artifact ? ' · Pinned' : ' · Preparation required'}</p>}
            {item.verification && <p>Connection: {item.verification.status}{item.verification.reason ? ` · ${item.verification.reason}` : ''}.</p>}
            {item.artifact?.verification && <p>Initialization: {item.artifact.verification.status}{item.artifact.verification.toolCount !== undefined ? ` · ${item.artifact.verification.toolCount} tools discovered` : ''}.</p>}
            {(item.verification || item.artifact?.verification) && <p className="text-muted-foreground">Connection checks only; tool calls have not been tested.</p>}
            {item.credentialRef && <p>Credentials connected · {item.credentialRef.provider}. Values are held by the gateway.</p>}
            {item.configuration?.endpoint && !item.credentialRef && <Note>Sign in through the sandbox’s agent after installation. Desktop OAuth sessions stay on this computer.</Note>}
            {item.kind === 'mcp' && !item.disabled && <label className="grid gap-1.5">Additional runtime hosts<Input aria-label={`Runtime hosts for ${item.name}`} disabled={busy || preparing} placeholder="api.example.com, files.example.com" value={(choices[item.id]?.hosts || []).join(', ')} onChange={e => choose(item.id, { hosts: e.target.value.split(',').map(h => h.trim()) })} /><span className="text-muted-foreground">Exact HTTPS destinations only. These are reviewed again against each sandbox’s policy.</span></label>}
            {item.credentialFields?.length > 0 && <div className="space-y-2 rounded border p-3">
              <p className="font-medium">Connect credentials</p>
              {item.sourceCredentialFields?.length > 0 && <label className="flex items-start gap-2"><Checkbox disabled={busy || preparing} checked={choices[item.id]?.useSourceSecrets || false} onCheckedChange={v => choose(item.id, { useSourceSecrets: Boolean(v) })} />Use credentials detected in the selected configuration ({item.sourceCredentialFields.join(', ')}). Store them in the gateway for this MCP.</label>}
              {item.credentialFields.filter(key => !choices[item.id]?.useSourceSecrets || !item.sourceCredentialFields?.includes(key)).map(key => <label key={key} className="grid gap-1">{key}<Input type="password" autoComplete="new-password" aria-label={`${item.name} ${key}`} disabled={busy || preparing} value={choices[item.id]?.secrets?.[key] || ''} onChange={e => choose(item.id, { secrets: { ...choices[item.id]?.secrets, [key]: e.target.value } })} /></label>)}
              <p className="text-muted-foreground">Credentials are destination-bound references. They are never saved in Setup files or images. Desktop OAuth sessions are not transferred.</p>
            </div>}
            {item.configuration && <details className="group/config">
              <summary className="flex cursor-pointer list-none items-center gap-2 rounded-sm text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden"><ChevronRight className="size-3 transition-transform group-open/config:rotate-90" />Configuration</summary>
              <pre className="mt-2 overflow-x-auto rounded border bg-muted/30 p-3 text-[11px]">{JSON.stringify(item.configuration, null, 2)}</pre>
            </details>}
            {item.files?.map((f) => <button key={f.path} disabled={busy} onClick={() => run(async () => setFile({ path: f.path, ...(await api.setupFile(review.token, item.id, f.path)) }))} className="flex w-full items-center gap-1.5 rounded px-1 py-1 text-left hover:bg-muted"><FileText className="size-3" /><span className="min-w-0 flex-1 truncate">{f.path}</span><span className="text-muted-foreground">{f.bytes} B</span></button>)}
          </AccordionContent>
        </AccordionItem>)}</Accordion>}</SetupItemTabs>
        {preparation && <div role="status" aria-live="polite" className="flex items-center gap-3 rounded-lg border bg-muted/30 p-3 text-xs">
          {preparing && <Spinner />}
          <span className="flex-1">{preparing ? preparation.message : preparedReview ? (importNeedsAttention(review) ? 'Checks finished. Some items need attention.' : 'Checks finished. Ready to save.') : 'Import paused.'}</span>
          {preparing && preparation.status === 'running' && <Button size="sm" variant="outline" onClick={() => { setupImports.cancel(jobId.current).catch(e => setError(e.message)) }}>Cancel import</Button>}
        </div>}
        {initialReview && <Button variant="ghost" disabled={preparing || busy} onClick={() => { setReview(null); setSources([...new Set(initialReview.items.flatMap(i => i.sources))]); setPreparation(null); setPreparedReview(false); setChoices({}) }}>Re-scan sources</Button>}

      </>}
      <ErrorMessage>{error}</ErrorMessage>
      </div>
      <div className="shrink-0 space-y-4 border-t bg-muted/20 px-6 py-4">
        {review && <p className="text-[11px] leading-relaxed text-muted-foreground">Import downloads dependencies and checks MCP connections in an isolated sandbox using the listed destinations and credentials you select. Skill scripts are not run.</p>}
      <div className="flex items-center justify-end gap-2">{scan && <Button variant="ghost" disabled={busy || preparing} onClick={() => { if (review) { setReview(null); setPreparedReview(false); setPreparation(null); setChoices({}) } else { setScan(null); setIds([]) } setError('') }}>Back</Button>}<Button variant="ghost" disabled={!jobId.current && !finalImport && (busy || preparing)} onClick={onClose}>{finalImport ? 'Continue in background' : jobId.current ? 'Close' : 'Cancel'}</Button>
        {review ? <>
          {preparedReview && <Button variant="outline" disabled={busy || !name.trim()} onClick={() => run(importSelection)}>Retry import</Button>}
          <Button disabled={busy || !name.trim()} onClick={() => run(() => importSelection(preparedReview))}>{busy && <Spinner />}{busy ? 'Importing…' : preparedReview && importNeedsAttention(review) ? 'Import with inactive items' : preparing ? 'Resume import' : 'Import'}</Button>
        </> : scan ? <Button disabled={busy || !ids.length} onClick={() => run(async () => setReview(await api.reviewSetup(scan.token, ids)))}>{busy && <Spinner />}Review selection</Button> : <Button disabled={busy || !sources.length} onClick={() => run(async () => setScan(await api.discoverSetups(sources)))}>{busy && <Spinner />}Discover tools</Button>}
      </div>
      </div>
    </DialogContent>
    {file && <Dialog open onOpenChange={() => setFile(null)}><DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-3xl"><DialogHeader><DialogTitle>{file.path}</DialogTitle><DialogDescription>Read-only file preview. Content is not executed.</DialogDescription></DialogHeader><pre className="whitespace-pre-wrap break-words rounded-lg border bg-muted/30 p-4 font-mono text-xs">{file.content}</pre></DialogContent></Dialog>}
  </Dialog>
}

function SetupDetail({ setup, sandbox, onUpdated, onClose, onPrepare }) {
  const [sandboxes, setSandboxes] = React.useState([])
  const [destination, setDestination] = React.useState(sandbox || '')
  const [targets, setTargets] = React.useState([])
  const [plan, setPlan] = React.useState(null)
  const [result, setResult] = React.useState(null)
  const [jobs, setJobs] = React.useState([])
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  React.useEffect(() => { api.overview().then((r) => setSandboxes(r.sandboxes)).catch((e) => setError(e.message)) }, [])
  React.useEffect(() => {
    let stopped = false, timer
    const refresh = async () => {
      try {
        const next = await api.setupJobs(setup.id)
        if (stopped) return
        setJobs(next)
        if (next.some((job) => job.status === 'waiting')) timer = setTimeout(refresh, 2000)
      } catch { /* The requirement check surfaces connection failures. */ }
    }
    refresh()
    return () => { stopped = true; clearTimeout(timer) }
  }, [setup.id, result])
  async function run(task) { setBusy(true); setError(''); try { await task() } catch (e) { setError(e.message); setPlan(null) } finally { setBusy(false) } }
  const signInItems = setup.items.filter(item => !item.disabled && !item.issues.length && !item.credentialRef && item.auth?.mode === 'agent-session')
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose() }}><DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg">
    <DialogHeader><DialogTitle>{setup.name}</DialogTitle><DialogDescription className="sr-only">Manage the MCPs and Skills in this saved setup.</DialogDescription></DialogHeader>
    <SetupItemTabs items={setup.items}>{(items) => <div className="max-h-72 divide-y overflow-y-auto rounded-lg border">{items.map((item) => <div key={item.id} className="flex items-start gap-2 px-3 py-2.5">
      <div className="min-w-0 flex-1 self-center">
        {item.issues.length || item.auth?.mode === 'agent-session' ? <details className="group/item">
          <summary className="flex cursor-pointer list-none items-center gap-2 rounded-sm text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
            <ChevronRight className="size-3 shrink-0 text-muted-foreground transition-transform group-open/item:rotate-90" />
            <span className="min-w-0 flex-1 break-words font-medium">{item.name}</span>
            <span className={`shrink-0 text-[10px] ${item.issues.length ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground'}`}>{item.issues.length ? 'Needs review' : 'Sign-in needed'}</span>
          </summary>
          <div className="space-y-1.5 pb-1 pl-5 pt-2 text-[11px] leading-relaxed text-muted-foreground">
            {item.issues.map(issue => <p key={issue}>{issue}</p>)}
            {item.auth?.mode === 'agent-session' && <p>Sign in inside the sandbox after installation.</p>}
          </div>
        </details> : <p className="break-words pl-5 text-xs font-medium">{item.name}</p>}
      </div>
      <Button variant="ghost" size="icon" className="size-6 shrink-0 text-muted-foreground hover:text-destructive" disabled={busy} aria-label={`Delete ${item.name} from setup`} title="Remove from saved setup only; installed copies stay in place" onClick={() => run(async () => { const updated = await api.deleteSetupItem(setup.id, item.id, setup.revision); setPlan(null); setResult(null); onUpdated(updated) })}><Trash2 className="size-3.5" /></Button>
    </div>)}</div>}</SetupItemTabs>
    <div className="flex items-center justify-between gap-3">
      <Button variant="outline" size="sm" onClick={onPrepare} disabled={busy}>{issueCount(setup) ? 'Resolve issues' : 'Prepare setup'}<ChevronRight className="size-3.5" /></Button>
    </div>
    <details className="group/install border-t pt-3" open={sandbox ? true : undefined}>
      <summary className="flex cursor-pointer list-none items-center justify-between rounded-sm text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">Install in a sandbox<ChevronRight className="size-3.5 text-muted-foreground transition-transform group-open/install:rotate-90" /></summary>
      <div className="space-y-3 pt-4">
    <fieldset disabled={busy} className="grid gap-3">
      <label className="grid gap-1.5 text-xs">Sandbox<SelectField aria-label="Setup destination" value={destination} onChange={(e) => { setDestination(e.target.value); setPlan(null); setResult(null) }} className="w-full text-xs"><option value="">Choose a sandbox</option>{sandboxes.map((s) => <option key={s.name} value={s.name}>{s.name} · {s.phase}</option>)}</SelectField></label>
      <div><p className="mb-2 text-xs">Enable for agents</p><div className="flex flex-wrap gap-4">{SETUP_AGENTS.map((s) => <label key={s.id} className="flex items-center gap-2 text-xs"><Checkbox disabled={!s.config} title={s.reason} checked={targets.includes(s.id)} onCheckedChange={(v) => { setTargets((old) => v ? [...old, s.id] : old.filter((id) => id !== s.id)); setPlan(null); setResult(null) }} />{s.name}{!s.config && <span className="text-muted-foreground"> · Unavailable</span>}</label>)}</div></div>
      <Button variant="outline" disabled={!destination || !targets.length || busy} onClick={() => run(async () => { setResult(null); setPlan(await api.previewSetup(setup.id, destination, targets)) })}>{busy && <Spinner />}Check requirements</Button>
    </fieldset>
    {plan && <div className="space-y-3">
      {plan.problems.map((p) => <p key={p} className="text-xs text-amber-700">{p}</p>)}
      {plan.network.map((r, i) => <div key={i} className="rounded-lg border p-3 text-xs"><p className="flex justify-between gap-2 font-medium"><span>{r.item} · {r.host}:{r.port}{r.path || ''}</span><span>{r.status === 'allowed' ? 'Existing access' : r.status === 'blocked' ? 'Blocked' : r.status === 'proposed' ? 'Requested access' : 'Needs review'}</span></p><p className="mt-1 text-muted-foreground">{r.reason}</p>{r.binaries?.length > 0 && <p className="mt-1 break-all font-mono text-muted-foreground">{r.binaries.join(', ')}</p>}{r.credentialProvider && <p>Credential binding: {r.credentialProvider}</p>}</div>)}
      {plan.inactive?.map(item => <p key={item.name} className="text-xs text-muted-foreground">{item.name}: inactive · {item.issues.join(' ')}</p>)}<Note>{plan.notes.join(' ')}</Note>
      {!plan.canEnable && <a href="#egress" onClick={onClose} className="inline-block text-xs underline underline-offset-4">Review access in Egress</a>}
      <div className="flex justify-end gap-2">{plan.installed && <Button variant="outline" disabled={busy} onClick={() => run(async () => { setResult(await api.removeSetup(setup.id, destination, plan.token)); setPlan(null) })}>Remove managed files</Button>}<Button disabled={busy || !plan.canEnable} onClick={() => run(async () => { setResult(await api.enableSetup(setup.id, destination, plan.token, plan.requiresApproval)); setPlan(null) })}>{busy && <Spinner />}{plan.requiresApproval ? 'Approve access & enable' : plan.installed ? 'Check & reapply' : 'Enable & check'}</Button></div>
    </div>}
    {result && <p role="status" className="rounded-lg border bg-muted/30 p-3 text-xs">{result.status === 'removed' ? 'Managed configuration removed. Restart the agent to unload it. Existing Egress rules were preserved.' : 'Prepared configuration installed. Restart the agent to load it. Connection checks below apply to this sandbox; they do not execute tools.'}</p>}
    {result?.checks?.map((check, i) => <p key={i} className="text-xs text-muted-foreground">{check.item}: {check.status}{check.toolCount !== undefined ? ` · ${check.toolCount} tools discovered` : ''}{check.reason ? ` · ${check.reason}` : ''}</p>)}
    {(result?.status === 'installed' || plan?.installed || jobs.some(j => j.sandbox === destination && j.status === 'installed')) && destination && signInItems.length > 0 && <div className="space-y-2 text-xs"><p className="font-medium">Sign in to {signInItems.map(item => item.name).join(', ')}</p><div className="flex flex-wrap gap-2">{targets.map(target => <a key={target} className="rounded-md border px-3 py-2 hover:bg-muted" href={terminalHref(destination, setupTarget(target)?.command || target)} target="_blank" rel="noreferrer">Open {setupTarget(target)?.name}</a>)}</div>{targets.includes('codex') && signInItems.filter(i => i.configuration?.endpoint).map(item => <a key={item.id} className="block underline underline-offset-4" href={`${terminalHref(destination, 'codex')}&setupLogin=${setup.id}&mcp=${encodeURIComponent(item.id)}`} target="_blank" rel="noreferrer">Sign in to {item.name} with Codex</a>)}<details className="text-[11px] text-muted-foreground"><summary className="cursor-pointer">About sign-in</summary><p className="mt-2">Use the agent’s MCP menu to authenticate and confirm tool availability. Sessions stay in this sandbox and are not baked into images. Console connection checks do not use these sessions.</p></details></div>}
    {jobs.filter((j) => !destination || j.sandbox === destination).map((job, i) => <p key={i} className="text-[11px] text-muted-foreground">{job.sandbox}: {job.status}{job.error ? ` · ${job.error}` : ''}</p>)}
      </div>
    </details>
    <ErrorMessage>{error}</ErrorMessage>
  </DialogContent></Dialog>
}

export function SetupPicker({ value = [], onChange, inherited = [], accessReview, onAccessReview, automaticAccess = false, autoPrepare = false, preparationContext = 'sandbox' }) {
  const [items, setItems] = React.useState([])
  const [error, setError] = React.useState('')
  React.useEffect(() => { api.setups().then(setItems).catch((e) => setError(e.message)) }, [])
  const selected = items.filter(s => value.includes(s.id) || inherited.includes(s.id))
  const eligible = (item) => autoPrepare ? launchableItem(item) : !item.disabled && !item.issues.length
  const pending = (setup) => autoPrepare ? setup.items.filter(canPrepareAtLaunch) : []
  const inactive = (setup) => setup.items.filter(item => !eligible(item))
  const networkHosts = [...new Set(selected.flatMap(setup => setup.items.filter(eligible).flatMap(item => (autoPrepare ? launchRequirements(item) : item.requirements).filter(r => ['runtime', 'auth'].includes(r.phase)).map(r => `${r.host}${Number(r.port) === 443 ? '' : `:${r.port}`}${r.path || ''}`))))]
  const needsSignIn = selected.some(setup => setup.items.some(item => eligible(item) && !item.credentialRef && item.auth?.mode === 'agent-session'))
  const selectionRevision = JSON.stringify(selected.map(setup => [setup.id, setup.revision]))
  React.useEffect(() => {
    onAccessReview?.(automaticAccess ? Object.fromEntries(JSON.parse(selectionRevision)) : null)
  }, [selectionRevision, automaticAccess, onAccessReview])
  return <div className="space-y-2"><p className="text-xs font-medium">MCPs & Skills</p>
    {items.map((setup) => <div key={setup.id} className="rounded-lg border p-2.5 text-xs">
      <label className="flex items-start gap-2"><Checkbox aria-label={`Use ${setup.name}`} disabled={inherited.includes(setup.id) || !setup.items.some(eligible)} checked={value.includes(setup.id) || inherited.includes(setup.id)} onCheckedChange={(v) => onChange(v ? [...value, setup.id] : value.filter((id) => id !== setup.id))} /><span className="min-w-0 flex-1"><span className="block truncate">{setup.name}{inherited.includes(setup.id) ? ' · From image template' : ''}</span><span className="mt-1 block text-[11px] text-muted-foreground">{count(setup, 'mcp')} MCPs · {count(setup, 'skill')} Skills{pending(setup).length ? ` · ${pending(setup).length} install automatically` : ''}{inactive(setup).length ? ` · ${inactive(setup).length} inactive` : ''}</span></span></label>
      {inactive(setup).length > 0 && <details className="mt-2 pl-6 text-[11px] text-muted-foreground"><summary className="cursor-pointer">Items that will stay inactive</summary><div className="mt-2 space-y-2">{inactive(setup).map((item) => <p key={item.id}><span className="font-medium text-foreground">{item.name}:</span> {item.issues.join(' ')}</p>)}<p>Resolve these items in MCPs &amp; Skills.</p></div></details>}
    </div>)}
    {onAccessReview && networkHosts.length > 0 && <div className="space-y-2 pt-1 text-xs">
      <p className="font-medium">{automaticAccess ? 'Required access' : 'Network access'}</p>
      <ul className="divide-y text-[11px] text-muted-foreground">{networkHosts.map(host => <li key={host} className="break-all py-1">{host}</li>)}</ul>
      {!automaticAccess && <>
        <label className="flex items-start gap-2"><Checkbox checked={Boolean(accessReview)} onCheckedChange={v => onAccessReview(v ? Object.fromEntries(selected.map(s => [s.id, s.revision])) : null)} />Allow these destinations for tools and connection checks.</label>
        {!accessReview && <p className="text-[11px] text-muted-foreground">Otherwise, review access in MCPs &amp; Skills before installation.</p>}
      </>}
    </div>}
    {!items.length && <p className="text-[11px] text-muted-foreground">Import tools from the MCPs &amp; Skills page to reuse them here.</p>}
    <ErrorMessage>{error}</ErrorMessage>
    {needsSignIn && <p className="text-[11px] text-muted-foreground">{preparationContext === 'template' ? 'Sign in after launching the sandbox.' : 'Sign in inside the sandbox after installation.'}</p>}
  </div>
}
