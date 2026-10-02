import * as React from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { Check, ChevronDown, Download, FileCode2, Info, Package, Plus, Terminal, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SelectField } from '@/components/ui/select-field'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Spinner } from '@/components/ui/spinner'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { SetupPicker } from '@/components/setups-view'
import { FormSection } from '@/components/form-section'
import { LocationChip, StepTrail } from '@/components/location-step'
import { useApi, useLocation } from '@/lib/location-context'
import { LocationBadge } from '@/components/location-badge'
import { buildTemplateWithSetups } from '@/lib/setup-template-build'
import { persistentGateway } from '@/lib/sandbox-session'
import { AGENTS, BASES, RUNTIMES, STARTS, dockerfileFor, newRecipe, recipeErrors, requiresShell, selectedAgents, splitPackages } from '@/lib/image-templates'

const action = 'bg-[var(--action)] text-[var(--action-foreground)] hover:bg-[var(--action)]/90'
// The same agent order and cards as New sandbox's Quick setup.
const PRIMARY_AGENTS = ['claude', 'codex', 'cursor', 'pi', 'antigravity', 'opencode'].map((id) => AGENTS.find((a) => a.id === id)).filter(Boolean)
const OTHER_AGENTS = AGENTS.filter((a) => !PRIMARY_AGENTS.includes(a))
// Which side-panel section holds each field, so a validation error can open it.
const SECTION_OF = { runtimes: 'runtimes', repository: 'repository', customAgents: 'custom', base: 'system', packages: 'system', setup: 'system', environment: 'environment' }

function Field({ label, hint, htmlFor, children }) {
  return <div className="grid content-start gap-1.5"><Label htmlFor={htmlFor} className="text-xs">{label}</Label>{children}{hint && <p className="text-[11px] leading-relaxed text-muted-foreground">{hint}</p>}</div>
}
function Choice({ type = 'checkbox', name, checked, onChange, disabled, children }) {
  return <label className="relative min-w-0">
    <input type={type} name={name} checked={checked} onChange={onChange} disabled={disabled} className="peer sr-only" />
    <span className="flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg border border-border bg-background px-3 py-2 text-xs transition-all hover:-translate-y-px hover:bg-muted/50 hover:shadow-sm motion-reduce:hover:translate-y-0 @3xl:min-h-14 peer-checked:border-foreground/40 peer-checked:bg-accent peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-disabled:pointer-events-none peer-disabled:opacity-50">{children}</span>
  </label>
}

// The few choices a team needs to start an agent on its repo up front, with
// everything else in the side panel. `replace` edits an existing template.
export function ImageTemplateBuilder(props) {
  const location = useLocation()
  return <ScopedImageTemplateBuilder key={location?.id ?? location?.context ?? 'default'} {...props} />
}

function ScopedImageTemplateBuilder({ initial, draftKey, onClose, onStarted, onChangeLocation }) {
  const api = useApi()
  const location = useLocation()
  const reduceMotion = useReducedMotion()
  const [recipe, setRecipe] = React.useState(() => newRecipe(initial?.recipe))
  const replace = Boolean(initial?.replace)
  const [baseline] = React.useState(() => initial?.baseline ?? JSON.stringify(newRecipe(initial?.recipe)))
  const [sections, setSections] = React.useState(() => new Set(Array.isArray(initial?.advanced) ? initial.advanced : initial?.advanced ? ['system', 'environment'] : newRecipe(initial?.recipe).customAgents.length ? ['custom'] : []))
  const section = (id) => ({ open: sections.has(id), onToggle: (e) => { const open = e.currentTarget.open; setSections((current) => open === current.has(id) ? current : new Set(open ? [...current, id] : [...current].filter((s) => s !== id))) } })
  const [custom, setCustom] = React.useState(() => !STARTS.some((s) => s.id === newRecipe(initial?.recipe).command))
  const [error, setError] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [preparing, setPreparing] = React.useState(false)
  const [progress, setProgress] = React.useState('')
  const preparation = React.useRef(null)
  React.useEffect(() => () => preparation.current?.abort(), [])
  const [local, setLocal] = React.useState(null)
  const [codeOpen, setCodeOpen] = React.useState(false)
  const [leaveOpen, setLeaveOpen] = React.useState(false)
  const build = recipe.source === 'build'
  const patch = (value) => {
    if (requiresShell({ ...recipe, ...value })) setCustom(false)
    setRecipe((r) => newRecipe({ ...r, ...value, ...(value.setups ? { setupRevisions: Object.fromEntries(Object.entries(r.setupRevisions || {}).filter(([id]) => value.setups.includes(id))) } : {}) }))
  }
  const dirty = JSON.stringify(recipe) !== baseline
  const errors = recipeErrors(recipe)
  React.useEffect(() => {
    try { sessionStorage.setItem(draftKey, JSON.stringify({ recipe, replace, baseline, advanced: [...sections] })) } catch { /* recovery is best effort */ }
  }, [draftKey, recipe, replace, baseline, sections])
  // On an SSH host, offer the latest snapshot of local MCPs & Skills, as New
  // sandbox does. Setups this template already uses stay visible.
  const remote = persistentGateway(location)
  const [catalog, setCatalog] = React.useState({ loading: remote, value: null, error: '' })
  const [catalogAttempt, setCatalogAttempt] = React.useState(0)
  const [savedSetups] = React.useState(() => newRecipe(initial?.recipe).setups)
  React.useEffect(() => {
    if (!remote) return
    let current = true
    setCatalog({ loading: true, value: null, error: '' })
    api.syncLocalCatalog()
      .then((value) => { if (current) setCatalog({ loading: false, value, error: '' }) })
      .catch((e) => { if (current) setCatalog({ loading: false, value: null, error: e.message }) })
    return () => { current = false }
  }, [api, remote, catalogAttempt])
  React.useEffect(() => {
    let current = true
    api.localImages().then((value) => { if (current) setLocal(value) }).catch((e) => { if (current) setLocal({ images: [], error: e.message }) })
    return () => { current = false }
  }, [api])
  React.useEffect(() => {
    const prevent = (event) => { if (dirty) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', prevent)
    return () => window.removeEventListener('beforeunload', prevent)
  }, [dirty])

  // Multiple installed agents share a shell; a single agent can start directly.
  function toggleAgent(id) {
    const agents = recipe.agents.includes(id) ? recipe.agents.filter((a) => a !== id) : AGENTS.filter((a) => a.id === id || recipe.agents.includes(a.id)).map((a) => a.id)
    const automatic = !custom && (recipe.command === '' ? recipe.agents.length === 0 : AGENTS.some((a) => a.command === recipe.command))
    if (agents.length > 1) setCustom(false)
    patch({ agents, ...(automatic ? { command: AGENTS.find((a) => a.id === agents[0])?.command ?? '' } : {}) })
  }
  const toggleRuntime = (id) => patch({ runtimes: recipe.runtimes.includes(id) ? recipe.runtimes.filter((r) => r !== id) : [...recipe.runtimes, id] })
  // Runtimes the chosen agents bring along even when not ticked.
  const bundled = [selectedAgents(recipe).some((a) => a.npm) && !recipe.runtimes.includes('node') && 'Node.js 22', selectedAgents(recipe).some((a) => a.python) && !recipe.runtimes.includes('python') && 'Python 3'].filter(Boolean)
  const starts = STARTS.filter((s) => !build || s.id === '' || recipe.agents.includes(AGENTS.find((a) => a.command === s.id)?.id))
  const runtimeSummary = [...RUNTIMES.filter((r) => recipe.runtimes.includes(r.id)).map((r) => r.name), ...bundled].join(', ')
  const systemSummary = [BASES.find((b) => b.id === recipe.base)?.name, `${recipe.packages.length} ${recipe.packages.length === 1 ? 'package' : 'packages'}`, recipe.setup.trim() && 'setup commands'].filter(Boolean).join(' · ')
  const environmentSummary = recipe.environment.length ? `${recipe.environment.length} ${recipe.environment.length === 1 ? 'variable' : 'variables'}` : ''

  async function submit(event) {
    event.preventDefault()
    const first = Object.entries(errors)[0] ?? (custom && !recipe.command.trim() ? ['command', 'Enter a start command, or pick one of the options.'] : null)
    if (first) {
      if (SECTION_OF[first[0]]) setSections((current) => new Set([...current, SECTION_OF[first[0]]]))
      setError(first[1]); return
    }
    if (busy || location?.connected === false) return
    setBusy(true); setPreparing(true); setError(''); setProgress('')
    const controller = new AbortController()
    preparation.current = controller
    try {
      onStarted(await buildTemplateWithSetups(api, recipe, replace, {
        signal: controller.signal, onProgress: setProgress, onPrepared: () => setPreparing(false),
      }))
    } catch (e) { if (e.name !== 'AbortError') setError(e.message) }
    finally { setBusy(false); setPreparing(false); setProgress(''); preparation.current = null }
  }
  function exportDockerfile() {
    const url = URL.createObjectURL(new Blob([dockerfileFor(recipe)], { type: 'text/plain' }))
    const a = document.createElement('a'); a.href = url; a.download = 'Dockerfile'; a.click(); URL.revokeObjectURL(url)
  }

  function requestClose() {
    if (busy) return
    if (dirty) setLeaveOpen(true)
    else onClose()
  }
  const reveal = (delay = 0) => ({ initial: reduceMotion ? false : { opacity: 0, y: 6 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.25, delay, ease: [0.22, 1, 0.36, 1] } })

  return <Dialog open onOpenChange={(open) => { if (!open) requestClose() }}>
    <DialogContent className="max-h-[90svh] gap-4 bg-transparent p-0 ring-0 sm:max-w-4xl">
    <form onSubmit={submit} className="@container flex max-h-[90svh] min-h-0 min-w-0 flex-col overflow-hidden rounded-xl bg-popover ring-1 ring-foreground/10">
    <Tabs value={recipe.source} onValueChange={(source) => { patch({ source }); if (source === 'build' && recipe.agents.length > 1) setCustom(false); setError('') }} className="contents">
    <DialogHeader className="shrink-0 gap-3 px-5 pt-5 pb-4 @3xl:px-7 @3xl:pt-6">
      {onChangeLocation && <div className="pr-8"><StepTrail step={2} subject="template" /></div>}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pr-8">
        <DialogTitle className="truncate">{replace ? `Edit ${recipe.name}` : 'New template'}</DialogTitle>
        {onChangeLocation ? <LocationChip location={location} onChange={onChangeLocation} /> : <LocationBadge location={location} />}
        <TabsList className="ml-auto w-fit" aria-label="Template image source">
          <TabsTrigger value="build" className="px-3 text-xs">Build an image</TabsTrigger>
          <TabsTrigger value="image" className="px-3 text-xs">Existing image</TabsTrigger>
        </TabsList>
      </div>
      <DialogDescription className="text-xs">
        {build ? 'Built on the console’s Docker engine. For an SSH host, the image is built for its architecture and transferred before the template is saved.' : 'Boots an image you already have, as is.'}
      </DialogDescription>
      {location?.connected === false && <p role="alert" className="text-xs text-destructive">This location is disconnected. Choose a connected location to save a template.</p>}
    </DialogHeader>

    <div className="grid min-h-0 flex-1 overflow-y-auto overscroll-contain border-t border-border @3xl:grid-cols-[minmax(0,1fr)_19rem] @3xl:overflow-hidden">
    <fieldset disabled={busy || location?.connected === false} className="contents">
      <motion.div {...reveal()} className="grid min-w-0 content-start gap-6 p-5 @3xl:overflow-y-auto @3xl:p-7">
        <div className="grid gap-1.5">
          <Label htmlFor="template-name" className="text-xs">Name</Label>
          <Input id="template-name" value={recipe.name} disabled={replace} maxLength={19} onChange={(e) => patch({ name: e.target.value.toLowerCase() })} placeholder="frontend-app" className="h-10 font-mono text-sm" autoFocus={!replace} aria-invalid={(error && errors.name && recipe.name) ? true : undefined} />
          {recipe.name && errors.name && <p className="text-[11px] text-destructive">{errors.name}</p>}
        </div>

        {build ? <fieldset className="min-w-0">
          <legend className="mb-1.5 text-xs font-medium">Agents</legend>
          <div className="grid grid-cols-2 gap-2 @3xl:grid-cols-3">
            {PRIMARY_AGENTS.map((a) => <Choice key={a.id} checked={recipe.agents.includes(a.id)} onChange={() => toggleAgent(a.id)}>
              <img src={a.logo} alt="" className="size-4 shrink-0 object-contain" />
              <span className="min-w-0 flex-1">{a.name}</span>
              {recipe.agents.includes(a.id) && <Check className="size-3.5 shrink-0" aria-hidden="true" />}
            </Choice>)}
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button type="button" variant="outline" className="mt-2 w-full justify-between text-xs" />}>
              <span className="truncate">{OTHER_AGENTS.filter((a) => recipe.agents.includes(a.id)).map((a) => a.name).join(', ') || 'More agents'}</span>
              <ChevronDown className="size-3.5 shrink-0" aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {OTHER_AGENTS.map((a) => <DropdownMenuCheckboxItem key={a.id} checked={recipe.agents.includes(a.id)} onCheckedChange={() => toggleAgent(a.id)} closeOnClick={false} className="text-xs">
                <img src={a.logo} alt="" className="size-4 shrink-0 object-contain" />{a.name}
              </DropdownMenuCheckboxItem>)}
            </DropdownMenuContent>
          </DropdownMenu>
        </fieldset> : <Field label="Image" htmlFor="template-image" hint={local?.error ? local.error : 'An image on the selected Docker engine, or a registry reference Docker is signed in to.'}>
          <Input id="template-image" value={recipe.image} onChange={(e) => patch({ image: e.target.value.trim() })} placeholder="ghcr.io/your-team/workspace:latest" className="font-mono text-xs" />
          {local?.images?.length > 0 && <SelectField aria-label="Choose an available image" value={local.images.some((i) => i.reference === recipe.image) ? recipe.image : ''} onChange={(e) => patch({ image: e.target.value })} className="w-full text-xs">
            <option value="" disabled>Choose an available image</option>
            {local.images.map((i) => <option key={i.reference} value={i.reference}>{i.reference}</option>)}
          </SelectField>}
        </Field>}

        <StartsIn starts={starts} recipe={recipe} custom={custom} setCustom={setCustom} patch={patch} />

        {error && <p role="alert" className="whitespace-pre-wrap rounded-md border border-red-200 bg-red-50/60 px-3 py-2 text-[11px] text-red-700">{error}</p>}
      </motion.div>

      <motion.aside {...reveal(0.06)} className="grid min-w-0 content-start gap-6 border-t border-border bg-muted/25 p-5 @3xl:overflow-y-auto @3xl:border-t-0 @3xl:border-l @3xl:p-6">
        {catalog.loading && <p role="status" className="text-xs text-muted-foreground">Loading your local MCPs &amp; Skills…</p>}
        {catalog.value?.available && <p className="text-xs text-muted-foreground">Your local MCPs &amp; Skills are available here. Existing remote templates keep their settings.</p>}
        {catalog.error && <div className="grid gap-2">
          <p role="alert" className="text-xs text-destructive">Could not load your local MCPs &amp; Skills: {catalog.error}</p>
          <Button type="button" variant="outline" size="sm" className="w-fit" onClick={() => setCatalogAttempt((n) => n + 1)}>Retry</Button>
        </div>}
        {!catalog.loading && <SetupPicker localCatalog={catalog.value} retained={savedSetups} autoPrepare preparationContext="template" value={recipe.setups} onChange={(setups) => patch({ setups })} />}

        <div className="grid min-w-0">
          {build && <FormSection title="Runtimes and tools" summary={runtimeSummary} {...section('runtimes')}>
            <div className="grid gap-2">{RUNTIMES.map((r) => <Choice key={r.id} checked={recipe.runtimes.includes(r.id)} onChange={() => toggleRuntime(r.id)}>
              <img src={r.logo} alt="" className="size-4 shrink-0 object-contain" />
              <span className="min-w-0 flex-1">{r.name}</span>
              {recipe.runtimes.includes(r.id) && <Check className="size-3.5 shrink-0" aria-hidden="true" />}
            </Choice>)}</div>
            {bundled.length > 0 && <p className="text-[11px] leading-relaxed text-muted-foreground">{bundled.join(' and ')} {bundled.length > 1 ? 'are' : 'is'} included for the selected agents.</p>}
          </FormSection>}
          {build && <FormSection title="Repository" summary={recipe.repository} {...section('repository')}>
            <Field htmlFor="template-repository" label="Clone at build time" hint="A public HTTPS repository, cloned into /sandbox/project. Private repositories can be cloned after launch.">
              <Input id="template-repository" value={recipe.repository} onChange={(e) => patch({ repository: e.target.value.trim() })} placeholder="https://github.com/your-team/project.git" className="font-mono text-xs" />
            </Field>
          </FormSection>}
          {build && <FormSection title="Custom agent" summary={recipe.customAgents.length ? 'Install command set' : ''} {...section('custom')}>
            <CustomAgents agents={recipe.customAgents} onChange={(customAgents) => { if (customAgents.length > recipe.customAgents.length) setCustom(false); patch({ customAgents, ...(customAgents.length > recipe.customAgents.length ? { command: '' } : {}) }) }} error={error ? errors.customAgents : undefined} />
          </FormSection>}
          {build && <FormSection title="System" summary={systemSummary} {...section('system')}>
            <Field label="Operating system" htmlFor="template-base">
              <SelectField id="template-base" value={recipe.base} onChange={(e) => patch({ base: e.target.value })} className="w-full text-xs">{BASES.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</SelectField>
            </Field>
            <PackageInput packages={recipe.packages} onChange={(packages) => patch({ packages })} />
            <Field label="Setup commands" htmlFor="template-setup" hint={`Run with bash in ${recipe.repository ? '/sandbox/project' : '/sandbox'} as the sandbox user, at build time. A failing command stops the build.`}>
              <Textarea id="template-setup" value={recipe.setup} onChange={(e) => patch({ setup: e.target.value })} rows={4} placeholder={recipe.runtimes.includes('python') ? 'pip install -r requirements.txt' : 'npm ci'} className="font-mono text-xs" spellCheck={false} />
            </Field>
          </FormSection>}
          <FormSection title="Environment variables" summary={environmentSummary} {...section('environment')}>
            <p className="text-[11px] leading-relaxed text-muted-foreground">Non-secret values, stored with the template. Attach credentials through Secrets when you launch.</p>
            {recipe.environment.map((e, i) => <div key={i} className="flex gap-1.5">
              <Input aria-label={`Variable ${i + 1} name`} className="min-w-0 flex-1 font-mono text-xs" value={e.name} onChange={(ev) => patch({ environment: recipe.environment.map((x, j) => i === j ? { ...x, name: ev.target.value } : x) })} placeholder="NODE_ENV" />
              <Input aria-label={`Variable ${i + 1} value`} className="min-w-0 flex-1 font-mono text-xs" value={e.value} onChange={(ev) => patch({ environment: recipe.environment.map((x, j) => i === j ? { ...x, value: ev.target.value } : x) })} placeholder="development" />
              <Button type="button" variant="ghost" size="icon" aria-label={`Remove variable ${i + 1}`} onClick={() => patch({ environment: recipe.environment.filter((_, j) => j !== i) })}><Trash2 /></Button>
            </div>)}
            <Button type="button" variant="outline" size="sm" className="justify-self-start" disabled={recipe.environment.length >= 40} onClick={() => patch({ environment: [...recipe.environment, { name: '', value: '' }] })}><Plus />Add variable</Button>
          </FormSection>
        </div>
        <p className="text-[11px] leading-relaxed text-muted-foreground">Software only. Network, file and credential access come from the groups and policies you pick at launch, plus the selected agents’ own sign-in and model destinations.</p>
      </motion.aside>
    </fieldset>
    </div>

    {(progress || replace) && <p role={progress ? 'status' : undefined} className="flex shrink-0 items-center gap-1.5 border-t border-border px-5 py-3 text-[11px] text-muted-foreground @3xl:px-7">
      {progress || <><Info className="size-3.5 shrink-0" aria-hidden="true" />{build ? 'Rebuilding replaces this template.' : 'Saving replaces this template.'} Sandboxes already running from it keep their current image.</>}
    </p>}
    <DialogFooter className="mx-0 mb-0 shrink-0 items-center rounded-none border-t border-border bg-popover px-5 py-4 @3xl:px-7">
      {build && <Button type="button" variant="ghost" className="sm:mr-auto" onClick={() => setCodeOpen(true)}><FileCode2 />View Dockerfile</Button>}
      <Button type="button" variant="ghost" disabled={busy && !preparing} onClick={() => preparing ? preparation.current?.abort() : requestClose()}>{preparing ? 'Cancel preparation' : 'Cancel'}</Button>
      <Button type="submit" className={action} disabled={busy || location?.connected === false}>{busy ? <Spinner /> : <Package />}{preparing ? 'Preparing MCPs…' : build ? (replace ? 'Rebuild template' : 'Build template') : 'Save template'}</Button>
    </DialogFooter>
    </Tabs>
    <Dialog open={codeOpen} onOpenChange={setCodeOpen}><DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>Generated Dockerfile</DialogTitle><DialogDescription>Setup commands are added as a separate build-context file.</DialogDescription></DialogHeader><pre className="overflow-x-auto rounded-md border bg-muted/30 p-4 font-mono text-[11px] leading-relaxed">{build ? dockerfileFor(recipe) : ''}</pre><Button type="button" variant="outline" onClick={exportDockerfile}><Download />Download Dockerfile</Button></DialogContent></Dialog>
    <Dialog open={leaveOpen} onOpenChange={setLeaveOpen}><DialogContent><DialogHeader><DialogTitle>Discard this template?</DialogTitle><DialogDescription>Your changes haven’t been built yet.</DialogDescription></DialogHeader><div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setLeaveOpen(false)}>Keep editing</Button><Button type="button" variant="destructive" onClick={onClose}>Discard</Button></div></DialogContent></Dialog>
  </form>
    </DialogContent>
  </Dialog>
}

function StartsIn({ starts, recipe, custom, setCustom, patch }) {
  const shellOnly = requiresShell(recipe)
  const options = [...(shellOnly ? STARTS.filter((s) => s.id === '') : starts)].sort((a, b) => (a.id === '' ? -1 : 0) - (b.id === '' ? -1 : 0))
  const card = (checked, icon, label, onChange, key) => <label key={key} className="relative min-w-0">
    <input type="radio" name="template-open-in" checked={checked} disabled={shellOnly} onChange={onChange} className="peer sr-only" />
    <span className="flex min-h-16 cursor-pointer items-center gap-2.5 rounded-lg border border-border bg-background px-3 py-3 text-xs transition-colors hover:bg-muted/50 peer-checked:border-foreground/40 peer-checked:bg-accent peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-disabled:pointer-events-none peer-disabled:opacity-80">
      {icon}<span className="min-w-0 flex-1 font-medium">{label}</span>
      <span aria-hidden="true" className={`flex size-3.5 shrink-0 items-center justify-center rounded-full border ${checked ? 'border-foreground' : 'border-muted-foreground/40'}`}>{checked && <span className="size-1.5 rounded-full bg-foreground" />}</span>
    </span>
  </label>
  return <fieldset className="min-w-0">
    <legend className="mb-1.5 text-xs font-medium">Open in</legend>
    <div className="grid grid-cols-2 gap-2 @3xl:grid-cols-3">
      {options.map((option) => {
        const agent = AGENTS.find((a) => a.command === option.id)
        return card(shellOnly || (!custom && recipe.command === option.id), agent ? <img src={agent.logo} alt="" className="size-5 shrink-0 object-contain" /> : <Terminal aria-hidden="true" className="size-5 shrink-0" />, option.name, () => { setCustom(false); patch({ command: option.id }) }, option.id || 'shell')
      })}
      {!shellOnly && card(custom, <FileCode2 aria-hidden="true" className="size-5 shrink-0" />, 'Custom command', () => { if (!custom) { setCustom(true); patch({ command: '' }) } }, 'custom')}
    </div>
    {!shellOnly && custom && <Input aria-label="Start command" value={recipe.command} onChange={(e) => patch({ command: e.target.value })} placeholder="npm run dev" className="mt-2 font-mono text-xs" />}
    <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">{shellOnly ? 'Multiple agents are installed. Start in Shell to run any of them.' : custom ? 'Runs through /bin/bash as the sandbox’s main process.' : 'Opens as a session you connect to. Exiting it keeps the sandbox running.'}</p>
  </fieldset>
}

function PackageInput({ packages, onChange }) {
  const [draft, setDraft] = React.useState('')
  const input = React.useRef(null)
  function add() {
    const next = splitPackages(draft)
    if (next.length) onChange([...new Set([...packages, ...next])])
    setDraft('')
  }
  return <Field label="System packages" htmlFor="template-packages" hint="Press Enter to add. Paste several separated by spaces, commas or new lines.">
    <div className="rounded-lg border bg-background p-2">
      {packages.length > 0 && <ul aria-label="System packages" className="mb-3 flex flex-wrap gap-1.5">
        {packages.map((name) => <li key={name} className="inline-flex max-w-full items-center gap-1 rounded-md border bg-muted/40 py-1 pl-2 pr-1">
          <span className="min-w-0 break-all font-mono text-[11px]">{name}</span>
          <button type="button" aria-label={`Remove package ${name}`} onClick={() => onChange(packages.filter((p) => p !== name))} className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"><X className="size-3" /></button>
        </li>)}
      </ul>}
      <div className="flex gap-2">
        <Input ref={input} id="template-packages" value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={add} onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); add() } }} onPaste={(e) => {
          const pasted = e.clipboardData.getData('text')
          if (/[\s,]/.test(pasted)) {
            e.preventDefault()
            const field = e.currentTarget
            const text = draft.slice(0, field.selectionStart) + pasted + draft.slice(field.selectionEnd)
            onChange([...new Set([...packages, ...splitPackages(text)])]); setDraft('')
          }
        }} placeholder="jq, unzip…" className="min-w-0 flex-1 font-mono text-xs" autoComplete="off" spellCheck={false} />
        <Button type="button" variant="outline" size="sm" onClick={() => { add(); input.current?.focus() }}><Plus />Add</Button>
      </div>
    </div>
  </Field>
}

function CustomAgents({ agents, onChange, error }) {
  return <div className="space-y-2">
    <Label htmlFor="custom-agent-install" className="text-xs">Install command</Label>
    <div className="flex items-start gap-2 rounded-lg border bg-background px-3 py-1 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30">
      <Terminal aria-hidden="true" className="mt-2 size-3.5 shrink-0 text-muted-foreground" />
      <Textarea id="custom-agent-install" value={agents.map((agent) => agent.install).join('\n')} onChange={(e) => onChange(e.target.value.trim() ? [{ name: 'Custom agent', install: e.target.value }] : [])} rows={1} maxLength={6000} spellCheck={false} autoComplete="off" placeholder="Paste an agent install command…" className="min-h-8 resize-none rounded-none border-0 bg-transparent px-0 py-1.5 font-mono text-xs leading-5 focus-visible:ring-0 md:text-xs" aria-invalid={Boolean(error)} />
    </div>
    {error && <p role="alert" className="text-[11px] text-destructive">{error}</p>}
  </div>
}
