import * as React from 'react'
import { ArrowDown, ArrowUp, Check, ChevronRight, FileText, FolderInput, Package, Plug, Plus, RefreshCw, Search, ShieldCheck, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { BlurFade } from '@/components/ui/blur-fade'
import { absoluteTime } from '@/lib/format'
import { Checkbox } from '@/components/ui/checkbox'
import { SelectField } from '@/components/ui/select-field'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'
import { api } from '@/lib/api'

const SOURCES = [{ id: 'codex', name: 'Codex', logo: 'codex' }, { id: 'claude', name: 'Claude Code', logo: 'claudecode' }, { id: 'cursor', name: 'Cursor', logo: 'cursor' }]
const count = (setup, kind) => setup.items.filter((item) => item.kind === kind).length
const issueCount = (setup) => setup.items.filter((item) => item.issues.length).length
function ErrorMessage({ children }) { return children ? <p role="alert" className="rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-xs text-destructive">{children}</p> : null }
function Note({ children }) { return <div className="flex gap-2 rounded-lg border bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground"><ShieldCheck className="mt-0.5 size-3.5 shrink-0" /><span>{children}</span></div> }

export function SetupsView({ sandbox = null }) {
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
  React.useEffect(() => { refresh() }, [refresh])
  const shown = React.useMemo(() => (setups || []).filter((setup) => {
    const matches = [setup.name, ...setup.items.flatMap(item => [item.name, ...(item.sources || [])])].join(' ').toLowerCase().includes(query.trim().toLowerCase())
    return matches && (status === 'all' || (status === 'review' ? issueCount(setup) > 0 : issueCount(setup) === 0))
  }).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }) * (descending ? -1 : 1)), [setups, query, status, descending])
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
          <p className="text-sm font-medium">{setups.length ? 'No matching setups' : 'No setups yet'}</p>
          <p className="mt-2 text-xs text-muted-foreground">{setups.length ? 'Try another name, tool, source agent, or status.' : 'Import MCPs and Skills from Codex, Claude Code, or Cursor.'}</p>
          <Button variant="outline" size="sm" className="mt-4" onClick={() => setups.length ? (setQuery(''), setStatus('all')) : setImporting(true)}>{setups.length ? 'Clear filters' : 'Bring my setup'}</Button>
        </div>
        : setups && <BlurFade duration={0.15} offset={0} blur="0px">
          <Table aria-label="Setups" className="min-w-[740px] text-xs">
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
    {importing && <ImportSetup onClose={() => setImporting(false)} onSaved={() => { setImporting(false); refresh() }} />}
    {selected && <SetupDetail setup={selected} sandbox={sandbox} onUpdated={(updated) => { setSelected(updated); setSetups((current) => current.map((entry) => entry.id === updated.id ? updated : entry)) }} onClose={() => setSelected(null)} />}
  </div>
}

function ImportSetup({ onClose, onSaved }) {
  const [sources, setSources] = React.useState([])
  const [scan, setScan] = React.useState(null)
  const [ids, setIds] = React.useState([])
  const [review, setReview] = React.useState(null)
  const [name, setName] = React.useState('My setup')
  const [query, setQuery] = React.useState('')
  const [acknowledged, setAcknowledged] = React.useState(false)
  const [file, setFile] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  async function run(task) { setBusy(true); setError(''); try { await task() } catch (e) { setError(e.message) } finally { setBusy(false) } }
  const items = scan?.items.filter((item) => `${item.name} ${item.kind} ${item.sources.join(' ')}`.toLowerCase().includes(query.toLowerCase())) ?? []
  const selectedIds = new Set(ids)
  const selectItems = (group, checked) => setIds((current) => {
    const next = new Set(current)
    for (const item of group) { if (checked) next.add(item.id); else next.delete(item.id) }
    return [...next]
  })
  const allVisibleSelected = items.length > 0 && items.every((item) => selectedIds.has(item.id))
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose() }}>
    <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
      <DialogHeader><DialogTitle>{review ? 'Review your setup' : scan ? 'Choose what to bring' : 'Bring my setup'}</DialogTitle><DialogDescription>{review ? 'Pinned files and configuration. Nothing will be executed or enabled yet.' : scan ? 'Only selected Skills are read next. Shared items are deduplicated; hidden files and caches are skipped.' : 'Read selected harness configurations on the computer running this console. Your local setup stays unchanged.'}</DialogDescription></DialogHeader>
      {!scan && <>
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
        <label className="grid gap-1.5 text-xs">Setup name<Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></label>
        <div className="space-y-2">{review.items.map((item) => <details key={item.id} className="rounded-lg border p-3"><summary className="cursor-pointer text-xs font-medium">{item.name}<span className="ml-2 font-normal text-muted-foreground">{item.kind === 'mcp' ? 'MCP' : `${item.files?.length ?? 0} files`}</span></summary>
          <div className="mt-3 space-y-2 text-[11px]">
            {item.configuration && <pre className="overflow-x-auto rounded border bg-muted/30 p-2">{JSON.stringify(item.configuration, null, 2)}</pre>}
            {item.requirements.map((r, i) => <p key={i}><span className="font-medium">{r.phase === 'build' ? 'Build' : 'Runtime'}:</span> {r.host}:{r.port} · {r.reason}</p>)}
            {item.kind === 'skill' && <p className="text-muted-foreground">Scripts are copied, never run during import. Runtime destinations are unknown and remain subject to sandbox policy.</p>}
            {item.credentialFields?.length > 0 && <p>Excluded environment/auth fields: {item.credentialFields.join(', ')}</p>}
            {item.issues.map((issue) => <p key={issue} className="text-amber-700">{issue}</p>)}
            {item.files?.map((f) => <button key={f.path} disabled={busy} onClick={() => run(async () => setFile({ path: f.path, ...(await api.setupFile(review.token, item.id, f.path)) }))} className="flex w-full items-center gap-1.5 rounded px-1 py-1 text-left hover:bg-muted"><FileText className="size-3" /><span className="min-w-0 flex-1 truncate">{f.path}</span><span className="text-muted-foreground">{f.bytes} B</span></button>)}
          </div>
        </details>)}</div>
        <Note>Credential detection is best-effort. Inspect the selected files before saving. Items with unresolved requirements can be saved for review but cannot be enabled.</Note>
        <label className="flex items-start gap-2 text-xs leading-relaxed"><Checkbox checked={acknowledged} onCheckedChange={(v) => setAcknowledged(Boolean(v))} />I reviewed the selected configuration and files and want to save this snapshot locally.</label>
      </>}
      <ErrorMessage>{error}</ErrorMessage>
      <div className="flex items-center justify-end gap-2">{scan && <Button variant="ghost" disabled={busy} onClick={() => { if (review) { setReview(null); setAcknowledged(false) } else { setScan(null); setIds([]) } setError('') }}>Back</Button>}<Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
        {review ? <Button disabled={busy || !acknowledged || !name.trim()} onClick={() => run(async () => { await api.saveSetup(review.token, name, acknowledged); onSaved() })}>{busy && <Spinner />}Save setup</Button> : scan ? <Button disabled={busy || !ids.length} onClick={() => run(async () => setReview(await api.reviewSetup(scan.token, ids)))}>{busy && <Spinner />}Review selection</Button> : <Button disabled={busy || !sources.length} onClick={() => run(async () => setScan(await api.discoverSetups(sources)))}>{busy && <Spinner />}Discover tools</Button>}
      </div>
    </DialogContent>
    {file && <Dialog open onOpenChange={() => setFile(null)}><DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-3xl"><DialogHeader><DialogTitle>{file.path}</DialogTitle><DialogDescription>Read-only file preview. Content is not executed.</DialogDescription></DialogHeader><pre className="whitespace-pre-wrap break-words rounded-lg border bg-muted/30 p-4 font-mono text-xs">{file.content}</pre></DialogContent></Dialog>}
  </Dialog>
}

function SetupDetail({ setup, sandbox, onUpdated, onClose }) {
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
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose() }}><DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-xl">
    <DialogHeader><DialogTitle>{setup.name}</DialogTitle><DialogDescription>{count(setup, 'mcp')} MCPs · {count(setup, 'skill')} Skills · Revision {setup.revision.slice(0, 8)}</DialogDescription></DialogHeader>
    <div className="divide-y rounded-lg border">{setup.items.map((item) => <div key={item.id} className="flex items-start gap-3 p-3"><div className="min-w-0 flex-1"><p className="break-words text-xs font-medium">{item.name}<span className="ml-2 font-normal text-muted-foreground">{item.kind === 'mcp' ? 'MCP' : 'Skill'}</span></p>{item.issues.map((issue) => <p key={issue} className="mt-1 text-[11px] text-amber-700">{issue}</p>)}</div><Button variant="ghost" size="icon" className="size-7 shrink-0 text-muted-foreground hover:text-destructive" disabled={busy} aria-label={`Delete ${item.name} from setup`} title={`Delete ${item.name} from setup`} onClick={() => run(async () => { const updated = await api.deleteSetupItem(setup.id, item.id, setup.revision); setPlan(null); setResult(null); onUpdated(updated) })}><Trash2 className="size-3.5" /></Button></div>)}{!setup.items.length && <p className="p-3 text-xs text-muted-foreground">This setup has no MCPs or Skills.</p>}</div>
    <p className="text-[11px] text-muted-foreground">Deleting a row updates this saved setup. Tools already installed in sandboxes or built images stay in place.</p>
    <Note>To bake these files into an image, select this Setup in Templates. Runtime access is checked again when a sandbox launches.</Note>
    <fieldset disabled={busy} className="grid gap-3">
      <label className="grid gap-1.5 text-xs">Sandbox<SelectField aria-label="Setup destination" value={destination} onChange={(e) => { setDestination(e.target.value); setPlan(null); setResult(null) }} className="w-full text-xs"><option value="">Choose a sandbox</option>{sandboxes.map((s) => <option key={s.name} value={s.name}>{s.name} · {s.phase}</option>)}</SelectField></label>
      <div><p className="mb-2 text-xs">Enable for agents</p><div className="flex flex-wrap gap-4">{SOURCES.map((s) => <label key={s.id} className="flex items-center gap-2 text-xs"><Checkbox checked={targets.includes(s.id)} onCheckedChange={(v) => { setTargets((old) => v ? [...old, s.id] : old.filter((id) => id !== s.id)); setPlan(null); setResult(null) }} />{s.name}</label>)}</div></div>
      <Button variant="outline" disabled={!destination || !targets.length || busy} onClick={() => run(async () => { setResult(null); setPlan(await api.previewSetup(setup.id, destination, targets)) })}>{busy && <Spinner />}Check requirements</Button>
    </fieldset>
    {plan && <div className="space-y-3">
      {plan.problems.map((p) => <p key={p} className="text-xs text-amber-700">{p}</p>)}
      {plan.network.map((r, i) => <div key={i} className="rounded-lg border p-3 text-xs"><p className="flex justify-between gap-2 font-medium"><span>{r.host}:{r.port}</span><span>{r.status === 'allowed' ? 'Existing access' : r.status === 'blocked' ? 'Blocked' : 'Needs review'}</span></p><p className="mt-1 text-muted-foreground">{r.reason}</p></div>)}
      <Note>{plan.notes.join(' ')}</Note>
      {!plan.canEnable && <a href="#egress" onClick={onClose} className="inline-block text-xs underline underline-offset-4">Review access in Egress</a>}
      <div className="flex justify-end gap-2">{plan.installed && <Button variant="outline" disabled={busy} onClick={() => run(async () => { setResult(await api.removeSetup(setup.id, destination, plan.token)); setPlan(null) })}>Remove managed files</Button>}<Button disabled={busy || !plan.canEnable} onClick={() => run(async () => { setResult(await api.enableSetup(setup.id, destination, plan.token)); setPlan(null) })}>{busy && <Spinner />}{plan.installed ? 'Verify and reapply' : 'Enable in sandbox'}</Button></div>
    </div>}
    {result && <p role="status" className="rounded-lg border bg-muted/30 p-3 text-xs">{result.status === 'removed' ? 'Managed configuration removed. Restart the agent to unload it. Existing Egress rules were preserved.' : 'Configuration installed and files verified. Restart the agent and sign in if needed. MCP connectivity has not been verified.'}</p>}
    {jobs.filter((j) => !destination || j.sandbox === destination).map((job, i) => <p key={i} className="text-[11px] text-muted-foreground">{job.sandbox}: {job.status}{job.error ? ` · ${job.error}` : ''}</p>)}
    <ErrorMessage>{error}</ErrorMessage>
  </DialogContent></Dialog>
}

export function SetupPicker({ value = [], onChange, inherited = [] }) {
  const [items, setItems] = React.useState([])
  const [error, setError] = React.useState('')
  React.useEffect(() => { api.setups().then(setItems).catch((e) => setError(e.message)) }, [])
  return <div className="space-y-2"><p className="text-xs font-medium">MCPs & Skills</p>
    {items.map((setup) => <div key={setup.id} className="rounded-lg border p-2.5 text-xs">
      <label className="flex items-start gap-2"><Checkbox aria-label={`Use ${setup.name}`} disabled={inherited.includes(setup.id) || issueCount(setup) > 0} checked={value.includes(setup.id) || inherited.includes(setup.id)} onCheckedChange={(v) => onChange(v ? [...value, setup.id] : value.filter((id) => id !== setup.id))} /><span className="min-w-0 flex-1"><span className="block truncate">{setup.name}{inherited.includes(setup.id) ? ' · From image template' : ''}</span><span className="mt-1 block text-[11px] text-muted-foreground">{count(setup, 'mcp')} MCPs · {count(setup, 'skill')} Skills{issueCount(setup) ? ` · ${issueCount(setup)} need attention` : ''}</span></span></label>
      {issueCount(setup) > 0 && <details className="mt-2 pl-6 text-[11px] text-muted-foreground"><summary className="cursor-pointer">Why can't I select this Setup?</summary><div className="mt-2 space-y-2">{setup.items.filter((item) => item.issues.length).map((item) => <p key={item.id}><span className="font-medium text-foreground">{item.name}:</span> {item.issues.join(' ')}</p>)}<p>Import a new Setup with the compatible items, or package these tools and reconnect their credentials before re-importing.</p></div></details>}
    </div>)}
    {!items.length && <p className="text-[11px] text-muted-foreground">Import tools from the Setups page to reuse them here.</p>}
    <ErrorMessage>{error}</ErrorMessage>
    {(value.length > 0 || inherited.length > 0) && <p className="text-[11px] leading-relaxed text-muted-foreground">Files are pinned to this revision. No imported commands run during the build. Runtime access and installed executables are checked at launch. The sandbox starts in Shell so you can review Setup status before opening an agent.</p>}
  </div>
}
