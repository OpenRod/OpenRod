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
import { LocationProvider, useApi, useLocation } from '@/lib/location-context'
import { LocationBadge } from '@/components/location-badge'
import { importNeedsAttention, inactiveItems, providedCredentials } from '@/lib/import-setup'
import { POLICY_HANDOFF } from '@/components/egress-view'
import { setupImports } from '@/lib/setup-imports'
import { inSetupPolicy, policyRows, setupAccess } from '@/lib/setup-network'
import { canPrepareAtLaunch, cannotRun, isPackagePending, launchableItem, launchRequirements } from '../../shared/setup-launch.js'

const SOURCES = [{ id: 'codex', name: 'Codex', logo: 'codex' }, { id: 'claude', name: 'Claude Code', logo: 'claudecode' }, { id: 'cursor', name: 'Cursor', logo: 'cursor' }]
const count = (setup, kind) => setup.items.filter((item) => item.kind === kind).length
// A package that only still needs downloading is ready: Import (or launch) installs it.
const openIssues = (item) => item.issues.filter(issue => !isPackagePending(issue))
const readyCount = (setup) => setup.items.filter(item => !item.disabled && !openIssues(item).length).length
const issueCount = (setup) => setup.items.filter((item) => openIssues(item).length).length
const sourceNames = (item) => item.sources.map(id => SOURCES.find(source => source.id === id)?.name || id).join(', ')
const hostLabel = (r) => `${r.host}${r.port && Number(r.port) !== 443 ? `:${r.port}` : ''}${r.path || ''}`
const REQUIREMENT_LABELS = { build: 'Downloads from', runtime: 'Connects to', auth: 'Sign-in' }
const CHECK_LABELS = { connected: 'Connected', 'needs-sign-in': 'Needs sign-in', 'needs-credentials': 'Needs credentials', unverified: 'Couldn’t check' }
const STATE_LABELS = { prepared: 'Ready', 'sign-in-in-sandbox': 'Sign in after install', 'needs-attention': 'Needs attention', disabled: 'Inactive' }
const itemStatus = (item) => item.disabled ? 'Inactive' : cannotRun(item) ? 'Can’t run in a sandbox' : openIssues(item).length ? 'Needs attention' : item.issues.length ? 'Installs on import' : item.kind === 'skill' ? `${item.files?.length ?? 0} files` : item.auth?.mode === 'agent-session' ? 'Sign in after install' : item.verification?.status === 'connected' ? 'Connected' : item.artifact ? 'Package ready' : 'Not checked yet'
// Same rule as the server's runtimeRequirements, so mistakes show before Import.
const validHost = (host) => /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/i.test(host) && !host.includes('..') && !host.includes('*') && !host.endsWith('.local')
const hostsError = (hosts = []) => hosts.some(host => !validHost(host)) ? 'Enter domain names like api.github.com (no wildcards, IP addresses or local names).' : hosts.length > 20 ? 'Add up to 20 websites.' : ''
// A local MCP with credentials but no known server must name where they may go; Import would otherwise stop after the download.
const needsHost = (item) => item.credentialFields?.length > 0 && !item.requirements.some(r => r.phase === 'runtime')
const hostsMissing = (item, choice) => needsHost(item) && providedCredentials(choice) && !choice?.hosts?.length
// What a save tells the egress policy popup: the policy, or why it wasn't saved.
const networkOutcome = (saved) => saved?.egressPolicy ?? (saved?.egressPolicyError ? { error: saved.egressPolicyError } : null)
const elapsed = (seconds) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
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

export function SetupsView(props) {
  const location = useLocation()
  return <ScopedSetupsView key={location?.context ?? 'default'} {...props} />
}

function ScopedSetupsView({ sandbox = null, setupIds = [] }) {
  const api = useApi()
  const location = useLocation()
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
  const [network, setNetwork] = React.useState(null)
  const refresh = React.useCallback(async () => {
    setRefreshing(true)
    try { setSetups(await api.setups()); setError('') } catch (e) { setError(e.message) }
    finally { setRefreshing(false) }
  }, [api])
  const importJobs = React.useSyncExternalStore(setupImports.subscribe, setupImports.getSnapshot)
  const completedImports = importJobs.filter(job => job.status === 'saved' && job.location?.context === location?.context).map(job => job.id).join(',')
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
    {deleting && <Dialog open onOpenChange={(open) => { if (!open && !deleteBusy) setDeleting(null) }}><DialogContent className="sm:max-w-md"><DialogHeader><DialogTitle>Delete “{deleting.name}”?</DialogTitle><DialogDescription>This deletes the setup and its egress policy. MCPs already installed in sandboxes stay, but lose access to the websites that policy allowed. Templates that use this setup need another setup before reuse.</DialogDescription></DialogHeader><ErrorMessage>{deleteError}</ErrorMessage><div className="flex justify-end gap-2"><Button variant="ghost" disabled={deleteBusy} onClick={() => setDeleting(null)}>Cancel</Button><Button variant="destructive" disabled={deleteBusy} onClick={async () => {
      setDeleteBusy(true); setDeleteError('')
      try {
        await api.deleteSetup(deleting.id, deleting.revision)
        setSetups((current) => current.filter((entry) => entry.id !== deleting.id))
        setSelected((current) => current?.id === deleting.id ? null : current)
        setDeleting(null)
      } catch (e) { setDeleteError(e.message) } finally { setDeleteBusy(false) }
    }}>{deleteBusy && <Spinner />}Delete setup</Button></div></DialogContent></Dialog>}
    {importing && <ImportSetup initialReview={importing.review} initialName={importing.name} onClose={() => setImporting(false)} onSaved={(saved) => { setImporting(false); refresh(); setNetwork(networkOutcome(saved)) }} />}
    {network && <SetupNetworkDialog policy={network} onClose={() => setNetwork(null)} />}
    {selected && <SetupDetail setup={selected} sandbox={sandbox} onPrepare={async () => { try { const review = await api.prepareSavedSetup(selected.id); setImporting({ review, name: selected.name + " (updated)" }); setSelected(null) } catch (e) { setError(e.message) } }} onUpdated={(updated) => { setSelected(updated); setSetups((current) => current.map((entry) => entry.id === updated.id ? updated : entry)) }} onClose={() => setSelected(null)} />}
  </div>
}

export function SetupImportNotifications() {
  const jobs = React.useSyncExternalStore(setupImports.subscribe, setupImports.getSnapshot)
  const [reviewing, setReviewing] = React.useState(null)
  const [network, setNetwork] = React.useState(null)
  return <>
    {jobs.length > 0 && <div aria-label="Import notifications" className="shrink-0 divide-y border-b bg-muted/30">
      {jobs.map(job => <div key={job.id} role={job.status === 'failed' || job.status === 'needs-attention' ? 'alert' : 'status'} className="flex items-center gap-3 px-4 py-3 text-xs sm:px-8">
        {job.status === 'importing' ? <Spinner /> : job.status === 'saved' ? <Check className="size-4 shrink-0 text-emerald-600" /> : <ShieldCheck className="size-4 shrink-0 text-amber-600" />}
        <div className="min-w-0 flex-1"><p className="font-medium">{job.name} · {job.status === 'importing' ? 'Importing' : job.status === 'saved' ? 'Imported' : job.status === 'cancelled' ? 'Import cancelled' : job.status === 'failed' ? 'Import failed' : 'Import needs attention'}</p><p className="mt-0.5 break-words text-muted-foreground">{job.message}</p></div>
        <LocationBadge location={job.location} />
        {!['importing', 'saved'].includes(job.status) && <Button size="sm" variant="outline" onClick={() => setReviewing(job)}>Review import</Button>}
        {job.status === 'saved' && networkOutcome(job.setup) && <Button size="sm" variant="outline" onClick={() => setNetwork({ policy: networkOutcome(job.setup), location: job.location })}>View egress policy</Button>}
        {job.status !== 'importing' && <Button size="sm" variant="ghost" aria-label={`Dismiss import notification for ${job.name}`} onClick={() => setupImports.dismiss(job.id)}>Dismiss</Button>}
      </div>)}
    </div>}
    {reviewing && <LocationProvider location={reviewing.location}><ImportSetup key={reviewing.id} initialJob={reviewing} initialReview={reviewing.review} initialName={reviewing.name} onClose={() => setReviewing(null)} onSaved={(saved) => { setNetwork({ policy: networkOutcome(saved), location: reviewing.location }); setReviewing(null) }} /></LocationProvider>}
    {network?.policy && <LocationProvider location={network.location}><SetupNetworkDialog policy={network.policy} onClose={() => setNetwork(null)} /></LocationProvider>}
  </>
}

// Saving a setup creates or updates its egress policy; this says what it allows.
function SetupNetworkDialog({ policy, onClose }) {
  const location = useLocation()
  const rows = policyRows(policy)
  const openInEgress = () => {
    try { sessionStorage.setItem(POLICY_HANDOFF, JSON.stringify({ edit: policy.id })) } catch { /* optional */ }
    onClose()
    window.dispatchEvent(new CustomEvent('openrod-navigate', { detail: { view: 'egress', location } }))
    // Egress may already be open; it then takes the handoff from this event.
    window.dispatchEvent(new Event(POLICY_HANDOFF))
  }
  if (policy.error) return <Dialog open onOpenChange={(open) => { if (!open) onClose() }}><DialogContent className="sm:max-w-md">
    <DialogHeader><DialogTitle>Egress policy not saved</DialogTitle><DialogDescription>The setup was saved, but its egress policy wasn’t. When you enable the setup on a sandbox, you approve its websites there instead.</DialogDescription></DialogHeader>
    <p className="text-xs text-muted-foreground">{policy.error}</p>
    <div className="flex justify-end"><Button onClick={onClose}>Done</Button></div>
  </DialogContent></Dialog>
  return <Dialog open onOpenChange={(open) => { if (!open) onClose() }}><DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-md">
    <DialogHeader><DialogTitle>{policy.created ? 'Egress policy created' : 'Egress policy updated'}</DialogTitle><DialogDescription>We {policy.created ? 'created' : 'updated'} the egress policy “{policy.name}”. Sandboxes that use this setup can now reach the websites below. This policy doesn’t open anything else.</DialogDescription></DialogHeader>
    {rows.length > 0 && <ul aria-label="Allowed websites" className="max-h-64 divide-y overflow-y-auto rounded-lg border text-xs">{rows.map(row => <li key={row.host} className="flex items-baseline justify-between gap-3 px-3 py-2"><span className="min-w-0 break-all font-mono">{row.host}</span>{row.items.length > 0 && <span className="max-w-[50%] text-right text-muted-foreground">{row.items.join(', ')}</span>}</li>)}</ul>}
    {policy.blocked?.length > 0 && <p className="text-xs text-amber-700 dark:text-amber-400">Not allowed because your organization blocks them: {policy.blocked.join(', ')}.</p>}
    {policy.approval?.length > 0 && <p className="text-xs text-muted-foreground">Not in this policy, because an MCP sends credentials there or names it as its sign-in service: {policy.approval.map(a => `${a.host} (${a.items.join(', ')})`).join(', ')}. You approve these for each sandbox when you enable the setup there.</p>}
    {(policy.sync?.error || policy.sync?.failed?.length > 0) && <p className="text-xs text-muted-foreground">The policy is saved, but some sandboxes that use this setup weren’t updated yet. The console keeps retrying in the background.</p>}
    <p className="text-[11px] text-muted-foreground">To let an MCP reach another website, add it to this policy in Network › Egress.</p>
    <div className="flex justify-end gap-2"><Button variant="outline" onClick={openInEgress}>Edit policy</Button><Button onClick={onClose}>Done</Button></div>
  </DialogContent></Dialog>
}

// Which of an MCP's websites its setup's egress policy opens, and which each sandbox approves.
function PolicyNote({ item }) {
  const hosts = (keep) => [...new Set(item.requirements.filter(r => ['runtime', 'auth'].includes(r.phase) && keep(r)).map(r => r.host.toLowerCase()))]
  const policy = hosts(r => inSetupPolicy(item, r)), approval = hosts(r => !inSetupPolicy(item, r))
  return <>
    {policy.length > 0 && <p className="text-muted-foreground">Import adds {policy.join(', ')} to this setup’s egress policy.</p>}
    {approval.length > 0 && <p className="text-muted-foreground">You approve {approval.join(', ')} for each sandbox when you enable the setup there{item.credentialRef || item.credentialFields?.length ? ', because this MCP sends credentials' : ''}.</p>}
  </>
}

function PreparationProgress({ preparation, onCancel }) {
  const running = preparation.status === 'running'
  const [now, setNow] = React.useState(Date.now)
  React.useEffect(() => { if (!running) return; setNow(Date.now()); const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer) }, [running])
  const started = Date.parse(preparation.createdAt)
  const current = running ? preparation.current : null
  const mcps = preparation.items?.filter(item => item.kind === 'mcp') ?? []
  const skills = preparation.items?.filter(item => item.kind === 'skill') ?? []
  const skillsDone = skills.every(item => item.state)
  const dot = <span className="size-1.5 rounded-full bg-muted-foreground/40" />
  return <>
    <div className="flex items-center gap-3">
      <Spinner />
      <span className="min-w-0 flex-1">{current && mcps.length ? 'Preparing your tools…' : preparation.message}</span>
      {running && !Number.isNaN(started) && <span aria-hidden="true" className="tabular-nums text-muted-foreground">{elapsed(Math.max(0, Math.floor((now - started) / 1000)))}</span>}
      {running && <Button size="sm" variant="outline" onClick={onCancel}>Cancel import</Button>}
    </div>
    {(mcps.length > 0 || skills.length > 0) && <ul aria-label="Import progress" className="space-y-1.5 border-t pt-2">
      {mcps.map(item => {
        const active = current?.id === item.id, skipped = !active && cannotRun(item)
        return <li key={item.id} className="flex items-center gap-2">
          <span className="flex size-3.5 shrink-0 items-center justify-center">{active ? <Spinner className="size-3.5" /> : skipped || !item.state || item.state === 'disabled' ? dot : item.state === 'needs-attention' ? <ShieldCheck className="size-3.5 text-amber-600" /> : <Check className="size-3.5 text-emerald-600" />}</span>
          <span className="min-w-0 flex-1 truncate">{item.name}</span>
          <span className="min-w-0 max-w-[60%] truncate text-right text-muted-foreground">{active ? current.message : skipped ? 'Skipped' : STATE_LABELS[item.state] || 'Waiting'}</span>
        </li>
      })}
      {skills.length > 0 && <li className="flex items-center gap-2">
        <span className="flex size-3.5 shrink-0 items-center justify-center">{skillsDone ? <Check className="size-3.5 text-emerald-600" /> : dot}</span>
        <span className="min-w-0 flex-1 truncate">{skills.length} {skills.length === 1 ? 'skill' : 'skills'}</span>
        <span className="text-muted-foreground">{skillsDone ? 'Done' : 'Waiting'}</span>
      </li>}
    </ul>}
  </>
}

function ExtraHosts({ item, choice, disabled, onChange }) {
  const error = hostsError(choice?.hosts) || (hostsMissing(item, choice) ? 'Enter at least one website, for example api.github.com.' : '')
  if (!needsHost(item)) return null
  return <div className="grid gap-1.5">
    <p className="font-medium">Where should this MCP send its credentials?</p>
    <p className="text-muted-foreground">{item.name} needs at least one website it may send {item.credentialFields.join(', ')} to, for example api.github.com.</p>
    <Input aria-label={`Websites for ${item.name}`} aria-invalid={error ? true : undefined} disabled={disabled} placeholder="e.g. api.github.com" value={choice?.hostsText ?? ''} onChange={e => onChange(e.target.value)} />
    <span className="text-muted-foreground">Domain names only, separated by commas or spaces. HTTPS only.</span>
    {error && <p className="text-amber-700 dark:text-amber-400">{error}</p>}
  </div>
}

function ImportSetup({ onClose, onSaved, initialReview = null, initialName = "My setup", initialJob = null }) {
  const api = useApi()
  const location = useLocation()
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
  const [importAttempted, setImportAttempted] = React.useState(Boolean(initialJob))
  const jobId = React.useRef(initialJob?.id)
  const mounted = React.useRef(true)
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const preparing = preparation?.status === 'running' || (busy && Boolean(preparation))
  const choose = (id, update) => { setPreparedReview(false); setChoices(old => ({ ...old, [id]: { ...old[id], ...update } })) }
  async function removeItem(id) {
    const next = await api.removeSetupReviewItem(review.token, id)
    setReview(next)
    setIds(current => current.filter(itemId => itemId !== id))
    setChoices(current => Object.fromEntries(Object.entries(current).filter(([itemId]) => itemId !== id)))
    setPreparation(null)
    if (jobId.current) setupImports.updateReview(jobId.current, next, preparedReview)
  }
  async function importSelection(saveOnly = false) {
    setImportAttempted(true)
    setFinalImport(true)
    const task = setupImports.start({ id: jobId.current, review, name, choices, saveOnly, api, location,
      resumeJob: preparation?.status === 'running' ? preparation : undefined,
    }, {
      onProgress: next => { if (mounted.current) setPreparation(next) },
      onReview: next => { if (mounted.current) { setReview(next); setPreparedReview(true); setChoices({}) } },
    })
    jobId.current = task.id
    try {
      const result = await task.promise
      if (!mounted.current) return
      if (result.status === 'saved') onSaved(result.setup)
      else if (result.status === 'needs-attention') setError('Some items couldn’t be prepared. Remove them or fix them, then retry the import.')
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
  const inactive = review ? inactiveItems(review, choices) : []
  const hostsInvalid = Object.values(choices).some(choice => hostsError(choice.hosts)) || Boolean(review?.items.some(item => !item.disabled && hostsMissing(item, choices[item.id])))
  return <Dialog open onOpenChange={(open) => { if (!open && (jobId.current || finalImport || (!busy && !preparing))) onClose() }}>
    <DialogContent className="flex max-h-[90svh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
      <DialogHeader className="shrink-0 px-6 pb-4 pt-6 pr-12"><DialogTitle>{review ? 'Import setup' : scan ? 'Choose what to bring' : 'Bring my setup'}</DialogTitle><DialogDescription>{review ? 'Import downloads and checks your MCPs, then saves the setup.' : scan ? 'Select the MCPs and skills to import. Items found in more than one agent are listed once.' : 'Choose the agents to import MCPs and skills from.'}</DialogDescription></DialogHeader>
      <div className="min-h-0 space-y-5 overflow-y-auto px-6 pb-5">
      {!scan && !review && <>
        <div className="grid gap-2 sm:grid-cols-3">{SOURCES.map((s) => <button key={s.id} type="button" aria-pressed={sources.includes(s.id)} onClick={() => setSources((v) => v.includes(s.id) ? v.filter((x) => x !== s.id) : [...v, s.id])} className={`flex items-center gap-2 rounded-xl border px-3 py-4 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring ${sources.includes(s.id) ? 'border-ring bg-muted' : 'bg-card'}`}><span className="flex size-7 items-center justify-center rounded-lg border bg-muted/30"><img src={`/logos/agents/${s.logo}.svg`} alt="" className="size-4" /></span>{s.name}{sources.includes(s.id) && <Check className="ml-auto size-3.5" />}</button>)}</div>
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
              <div className="max-h-64 divide-y overflow-y-auto">{group.map((item) => <label key={item.id} className="flex cursor-pointer items-start gap-3 p-3"><Checkbox disabled={busy} aria-label={`Import ${item.name} from ${sourceNames(item)}`} checked={selectedIds.has(item.id)} onCheckedChange={(checked) => selectItems([item], checked)} /><span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium">{item.name}</span><span className="mt-1 block text-[11px] text-muted-foreground">{sourceNames(item)}{cannotRun(item) ? ' · Can’t run in a sandbox' : openIssues(item).length ? ' · Needs attention' : ''}</span></span></label>)}{!group.length && <p className="p-4 text-xs text-muted-foreground">{query.trim() ? `No matching ${label}` : `No ${label} found`}</p>}</div>
            </section>
          })}
        </div>
        {query.trim() && <p className="text-[11px] text-muted-foreground">Select all only affects the search results. Other selections are kept.</p>}
        {scan.warnings.map((warning) => <p key={warning} className="text-[11px] text-muted-foreground">{warning}</p>)}
      </>}
      {review && <>
        <label className="grid gap-1.5 text-xs">Setup name<Input disabled={busy} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></label>
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>{readyCount(review)} ready · {issueCount(review)} need attention</span>
        </div>
        <SetupItemTabs items={review.items}>{(items) => <Accordion className="overflow-hidden rounded-lg border">{items.map((item) => <AccordionItem key={item.id} value={item.id}>
          <div className="flex items-center [&>h3]:min-w-0 [&>h3]:flex-1">
          <AccordionTrigger className="items-center gap-3 rounded-none px-3 py-3 text-xs hover:bg-muted/30 hover:no-underline">
            <span className="min-w-0 flex-1 break-words">{item.name}</span>
            <span className={`shrink-0 text-[11px] font-normal ${['Needs attention', 'Can’t run in a sandbox'].includes(itemStatus(item)) ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground'}`}>{itemStatus(item)}</span>
          </AccordionTrigger>
          <Button variant="ghost" size="icon" className="mr-2 size-7 shrink-0 text-muted-foreground hover:text-destructive" disabled={busy || preparing} aria-label={`Remove ${item.name} from import`} title="Remove from this import" onClick={() => run(() => removeItem(item.id))}><Trash2 className="size-3.5" /></Button>
          </div>
          <AccordionContent className="space-y-3 border-t bg-muted/10 px-4 py-4 text-xs leading-relaxed [&_p:not(:last-child)]:mb-0">
            {openIssues(item).length > 0 && <div className="space-y-1 text-amber-700 dark:text-amber-400">{openIssues(item).map(issue => <p key={issue}>{issue}</p>)}</div>}
            {item.requirements.length > 0 && <div className="space-y-1"><p className="text-[11px] font-medium text-muted-foreground">Network access</p>{item.requirements.map((r, i) => <p key={i}><span className="font-medium">{REQUIREMENT_LABELS[r.phase] || r.phase}:</span> {hostLabel(r)}<span className="text-muted-foreground"> · {r.reason}</span></p>)}{item.kind === 'mcp' && !item.disabled && !openIssues(item).some(issue => !issue.startsWith('Connect credentials')) && <PolicyNote item={item} />}</div>}
            {item.package && <p>npm package {item.package.name}@{item.artifact?.version || item.package.requested}{item.artifact ? ' · downloaded and version-locked' : ' · downloads when you press Import'}</p>}
            {item.verification && <p>Connection: {CHECK_LABELS[item.verification.status] || item.verification.status}{item.verification.reason ? ` · ${item.verification.reason}` : ''}</p>}
            {item.artifact?.verification && <p>Startup check: {CHECK_LABELS[item.artifact.verification.status] || item.artifact.verification.status}{item.artifact.verification.toolCount !== undefined ? ` · ${item.artifact.verification.toolCount} tools found` : ''}</p>}
            {item.credentialRef && <p>Credentials connected · {item.credentialRef.provider}. Values are held by the gateway.</p>}
            {item.configuration?.endpoint && !item.credentialRef && <Note>If this MCP needs an account, sign in from the agent inside the sandbox. Your desktop sign-in isn’t copied.</Note>}
            {item.kind === 'mcp' && !item.disabled && (item.configuration || item.package) && !item.configuration?.endpoint && <ExtraHosts item={item} choice={choices[item.id]} disabled={busy || preparing} onChange={hostsText => choose(item.id, { hostsText, hosts: hostsText.split(/[\s,]+/).map(h => h.replace(/^https?:\/\//i, '').split('/')[0].toLowerCase()).filter(Boolean) })} />}
            {item.credentialFields?.length > 0 && <div className="space-y-2 rounded border p-3">
              <p className="font-medium">Connect credentials</p>
              {item.sourceCredentialFields?.length > 0 && <label className="flex items-start gap-2"><Checkbox disabled={busy || preparing} checked={choices[item.id]?.useSourceSecrets || false} onCheckedChange={v => choose(item.id, { useSourceSecrets: Boolean(v) })} />Use the credentials from your config file ({item.sourceCredentialFields.join(', ')}).</label>}
              {item.credentialFields.filter(key => !choices[item.id]?.useSourceSecrets || !item.sourceCredentialFields?.includes(key)).map(key => <label key={key} className="grid gap-1">{key}<Input type="password" autoComplete="new-password" aria-label={`${item.name} ${key}`} disabled={busy || preparing} value={choices[item.id]?.secrets?.[key] || ''} onChange={e => choose(item.id, { secrets: { ...choices[item.id]?.secrets, [key]: e.target.value } })} /></label>)}
              <p className="text-muted-foreground">Stored in the gateway and sent only to this MCP’s server. Never saved in the setup or in images.</p>
            </div>}
            {item.configuration && <details className="group/config">
              <summary className="flex cursor-pointer list-none items-center gap-2 rounded-sm text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden"><ChevronRight className="size-3 transition-transform group-open/config:rotate-90" />Configuration</summary>
              <pre className="mt-2 overflow-x-auto rounded border bg-muted/30 p-3 text-[11px]">{JSON.stringify(item.configuration, null, 2)}</pre>
            </details>}
            {item.files?.map((f) => <button key={f.path} disabled={busy} onClick={() => run(async () => setFile({ path: f.path, ...(await api.setupFile(review.token, item.id, f.path)) }))} className="flex w-full items-center gap-1.5 rounded px-1 py-1 text-left hover:bg-muted"><FileText className="size-3" /><span className="min-w-0 flex-1 truncate">{f.path}</span><span className="text-muted-foreground">{f.bytes} B</span></button>)}
          </AccordionContent>
        </AccordionItem>)}</Accordion>}</SetupItemTabs>
        {preparation && <div role="status" aria-live="polite" className="space-y-2 rounded-lg border bg-muted/30 p-3 text-xs">
          {preparing ? <PreparationProgress preparation={preparation} onCancel={() => { setupImports.cancel(jobId.current).catch(e => setError(e.message)) }} /> : <p>{preparedReview ? (importNeedsAttention(review) ? 'Checks finished. Some items need attention.' : 'Checks finished. Ready to save.') : 'Not finished. Press Import to continue.'}</p>}
        </div>}
        {initialReview && <Button variant="ghost" disabled={preparing || busy} onClick={() => { setReview(null); setSources([...new Set(initialReview.items.flatMap(i => i.sources))]); setPreparation(null); setPreparedReview(false); setChoices({}) }}>Re-scan sources</Button>}

      </>}
      <ErrorMessage>{error}</ErrorMessage>
      </div>
      <div className="shrink-0 space-y-4 border-t bg-muted/20 px-6 py-4">
        {review && !preparing && !preparedReview && inactive.length > 0 && <p className="text-xs text-muted-foreground">{inactive.map(item => item.name).join(', ')} will be saved as inactive. You can fix {inactive.length === 1 ? 'it' : 'them'} later.</p>}
      <div className="flex items-center justify-end gap-2">{scan && <Button variant="ghost" disabled={busy || preparing} onClick={() => { if (review) { setReview(null); setPreparedReview(false); setPreparation(null); setChoices({}) } else { setScan(null); setIds([]) } setError('') }}>Back</Button>}<Button variant="ghost" disabled={!jobId.current && !finalImport && (busy || preparing)} onClick={onClose}>{finalImport ? 'Continue in background' : jobId.current ? 'Close' : 'Cancel'}</Button>
        {review ? <Button disabled={busy || !name.trim() || !review.items.length || hostsInvalid} onClick={() => run(() => importSelection(preparedReview && !importNeedsAttention(review)))}>{busy && <Spinner />}{busy ? 'Importing…' : preparing ? 'Resume import' : importAttempted ? 'Retry import' : 'Import'}</Button>
        : scan ? <Button disabled={busy || !ids.length} onClick={() => run(async () => { setReview(await api.reviewSetup(scan.token, ids)); setImportAttempted(false) })}>{busy && <Spinner />}Review selection</Button> : <Button disabled={busy || !sources.length} onClick={() => run(async () => setScan(await api.discoverSetups(sources)))}>{busy && <Spinner />}Discover tools</Button>}
      </div>
      </div>
    </DialogContent>
    {file && <Dialog open onOpenChange={() => setFile(null)}><DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-3xl"><DialogHeader><DialogTitle>{file.path}</DialogTitle><DialogDescription>Read-only file preview. Content is not executed.</DialogDescription></DialogHeader><pre className="whitespace-pre-wrap break-words rounded-lg border bg-muted/30 p-4 font-mono text-xs">{file.content}</pre></DialogContent></Dialog>}
  </Dialog>
}

function SetupDetail({ setup, sandbox, onUpdated, onClose, onPrepare }) {
  const api = useApi()
  const location = useLocation()
  const [sandboxes, setSandboxes] = React.useState([])
  const [context, setContext] = React.useState(null)
  const [destination, setDestination] = React.useState(sandbox || '')
  const [targets, setTargets] = React.useState([])
  const [plan, setPlan] = React.useState(null)
  const [result, setResult] = React.useState(null)
  const [jobs, setJobs] = React.useState([])
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  React.useEffect(() => {
    let current = true
    api.overview().then((r) => { if (current) { setSandboxes(r.sandboxes); setContext(r.gateway) } }).catch((e) => { if (current) setError(e.message) })
    return () => { current = false }
  }, [api])
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
  }, [setup.id, result, api])
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
            <span className={`shrink-0 text-[10px] ${openIssues(item).length ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground'}`}>{openIssues(item).length ? 'Needs review' : item.issues.length ? 'Installs automatically' : 'Sign-in needed'}</span>
          </summary>
          <div className="space-y-1.5 pb-1 pl-5 pt-2 text-[11px] leading-relaxed text-muted-foreground">
            {item.issues.map(issue => <p key={issue}>{issue}</p>)}
            {item.auth?.mode === 'agent-session' && <p>Sign in inside the sandbox after installation.</p>}
          </div>
        </details> : <p className="break-words pl-5 text-xs font-medium">{item.name}</p>}
      </div>
      <Button variant="ghost" size="icon" className="size-6 shrink-0 text-muted-foreground hover:text-destructive" disabled={busy} aria-label={`Delete ${item.name} from setup`} title={item.kind === 'mcp' ? 'Remove from this setup. Copies already installed in sandboxes stay, but lose the website access only this MCP needed.' : 'Remove from this setup. Copies already installed in sandboxes stay.'} onClick={() => run(async () => { const { egressPolicyError, ...updated } = await api.deleteSetupItem(setup.id, item.id, setup.revision); setPlan(null); setResult(null); onUpdated(updated); if (egressPolicyError) setError(`Removed. The setup’s egress policy wasn’t updated: ${egressPolicyError}`) })}><Trash2 className="size-3.5" /></Button>
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
      {plan.network.map((r, i) => <div key={i} className="rounded-lg border p-3 text-xs"><p className="flex justify-between gap-2 font-medium"><span>{r.item} · {r.host}:{r.port}{r.path || ''}</span><span>{r.status === 'allowed' ? 'Existing access' : r.status === 'policy' ? 'Allowed by setup policy' : r.status === 'blocked' ? 'Blocked' : r.status === 'proposed' ? 'Requested access' : 'Needs review'}</span></p><p className="mt-1 text-muted-foreground">{r.reason}</p>{r.binaries?.length > 0 && <p className="mt-1 break-all font-mono text-muted-foreground">{r.binaries.join(', ')}</p>}{r.credentialProvider && <p>Credential binding: {r.credentialProvider}</p>}</div>)}
      {plan.inactive?.map(item => <p key={item.name} className="text-xs text-muted-foreground">{item.name}: inactive · {item.issues.join(' ')}</p>)}{plan.notes.length > 0 && <Note>{plan.notes.join(' ')}</Note>}
      {!plan.canEnable && <button type="button" onClick={() => { onClose(); window.dispatchEvent(new CustomEvent('openrod-navigate', { detail: { view: 'egress', location } })) }} className="inline-block text-xs underline underline-offset-4">Review access in Network › Egress</button>}
      <div className="flex justify-end gap-2">{plan.installed && <Button variant="outline" disabled={busy} onClick={() => run(async () => { setResult(await api.removeSetup(setup.id, destination, plan.token)); setPlan(null) })}>Remove from sandbox</Button>}<Button disabled={busy || !plan.canEnable} onClick={() => run(async () => { setResult(await api.enableSetup(setup.id, destination, plan.token, plan.requiresApproval)); setPlan(null) })}>{busy && <Spinner />}{plan.requiresApproval ? 'Approve access & enable' : plan.installed ? 'Check & reapply' : 'Enable & check'}</Button></div>
    </div>}
    {result && <p role="status" className="rounded-lg border bg-muted/30 p-3 text-xs">{result.status === 'removed' ? 'Removed from this sandbox. Restart the agent to unload it. The sandbox no longer gets this setup’s egress policy; access you approved for it separately stays.' : 'Prepared configuration installed. Restart the agent to load it. Connection checks below apply to this sandbox; they do not execute tools.'}</p>}
    {result?.checks?.map((check, i) => <p key={i} className="text-xs text-muted-foreground">{check.item}: {check.status}{check.toolCount !== undefined ? ` · ${check.toolCount} tools discovered` : ''}{check.reason ? ` · ${check.reason}` : ''}</p>)}
    {(result?.status === 'installed' || plan?.installed || jobs.some(j => j.sandbox === destination && j.status === 'installed')) && destination && context?.name && context?.workspace && signInItems.length > 0 && <div className="space-y-2 text-xs"><p className="font-medium">Sign in to {signInItems.map(item => item.name).join(', ')}</p><div className="flex flex-wrap gap-2">{targets.map(target => <a key={target} className="rounded-md border px-3 py-2 hover:bg-muted" href={terminalHref(destination, setupTarget(target)?.command || target, context)} target="_blank" rel="noreferrer">Open {setupTarget(target)?.name}</a>)}</div>{targets.includes('codex') && signInItems.filter(i => i.configuration?.endpoint).map(item => <a key={item.id} className="block underline underline-offset-4" href={`${terminalHref(destination, 'codex', context)}&setupLogin=${setup.id}&mcp=${encodeURIComponent(item.id)}`} target="_blank" rel="noreferrer">Sign in to {item.name} with Codex</a>)}<details className="text-[11px] text-muted-foreground"><summary className="cursor-pointer">About sign-in</summary><p className="mt-2">Use the agent’s MCP menu to authenticate and confirm tool availability. Sessions stay in this sandbox and are not baked into images. Console connection checks do not use these sessions.</p></details></div>}
    {jobs.filter((j) => !destination || j.sandbox === destination).map((job, i) => <p key={i} className="text-[11px] text-muted-foreground">{job.sandbox}: {job.status}{job.error ? ` · ${job.error}` : ''}</p>)}
      </div>
    </details>
    <ErrorMessage>{error}</ErrorMessage>
  </DialogContent></Dialog>
}

export function SetupPicker(props) {
  const location = useLocation()
  return <ScopedSetupPicker key={location?.context ?? 'default'} {...props} />
}

function ScopedSetupPicker({ value = [], onChange, inherited = [], accessReview, onAccessReview, automaticAccess = false, autoPrepare = false, preparationContext = 'sandbox' }) {
  const api = useApi()
  const [items, setItems] = React.useState([])
  const [error, setError] = React.useState('')
  // Hosts a setup's egress policy allows need no approval. Without policies, all do.
  const [policies, setPolicies] = React.useState(null)
  const reviewsAccess = Boolean(onAccessReview)
  React.useEffect(() => {
    let current = true
    api.setups().then((value) => { if (current) setItems(value) }).catch((e) => { if (current) setError(e.message) })
    return () => { current = false }
  }, [api])
  React.useEffect(() => {
    if (!reviewsAccess) return
    let current = true
    api.org().then(org => { if (current) setPolicies(org.policies ?? null) }).catch(() => { if (current) setPolicies(null) })
    return () => { current = false }
  }, [reviewsAccess, api])
  const selected = items.filter(s => value.includes(s.id) || inherited.includes(s.id))
  const eligible = (item) => autoPrepare ? launchableItem(item) : !item.disabled && !item.issues.length
  const pending = (setup) => autoPrepare ? setup.items.filter(canPrepareAtLaunch) : []
  const inactive = (setup) => setup.items.filter(item => !eligible(item))
  const access = setupAccess(selected, policies, setup => setup.items.filter(eligible), item => autoPrepare ? launchRequirements(item) : item.requirements)
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
    {onAccessReview && access.uncovered.length > 0 && <div className="space-y-2 pt-1 text-xs">
      <p className="font-medium">{automaticAccess ? 'Required access' : 'Network access'}</p>
      <ul className="divide-y text-[11px] text-muted-foreground">{access.uncovered.map(host => <li key={host} className="break-all py-1">{host}</li>)}</ul>
      {!automaticAccess && <>
        <label className="flex items-start gap-2"><Checkbox checked={Boolean(accessReview)} onCheckedChange={v => onAccessReview(v ? Object.fromEntries(selected.map(s => [s.id, s.revision])) : null)} />Allow these destinations for tools and connection checks.</label>
        {!accessReview && <p className="text-[11px] text-muted-foreground">Otherwise, review access in MCPs &amp; Skills before installation.</p>}
      </>}
    </div>}
    {onAccessReview && access.covered.length > 0 && <div className="space-y-2 pt-1 text-xs">
      <p className="font-medium">{selected.length > 1 ? 'Allowed by the setups’ egress policies' : 'Allowed by the setup’s egress policy'}</p>
      <ul className="divide-y text-[11px] text-muted-foreground">{access.covered.map(host => <li key={host} className="break-all py-1">{host}</li>)}</ul>
    </div>}
    <ErrorMessage>{error}</ErrorMessage>
    {needsSignIn && <p className="text-[11px] text-muted-foreground">{preparationContext === 'template' ? 'Sign in after launching the sandbox.' : 'Sign in inside the sandbox after installation.'}</p>}
  </div>
}
