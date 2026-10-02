import * as React from 'react'
import { Check, ChevronDown, Download, FileCode2, Info, Package, Plus, ShieldCheck, Terminal, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SelectField } from '@/components/ui/select-field'
import { BlurFade } from '@/components/ui/blur-fade'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { Spinner } from '@/components/ui/spinner'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { SetupPicker } from '@/components/setups-view'
import { useApi, useLocation } from '@/lib/location-context'
import { LocationBadge } from '@/components/location-badge'
import { buildTemplateWithSetups } from '@/lib/setup-template-build'
import { AGENTS, BASES, RUNTIMES, STARTS, dockerfileFor, newRecipe, recipeErrors, requiresShell, selectedAgents, splitPackages } from '@/lib/image-templates'

const action = 'bg-[var(--action)] text-[var(--action-foreground)] hover:bg-[var(--action)]/90'

function Field({ label, hint, htmlFor, children }) {
  return <div className="grid content-start gap-2"><Label htmlFor={htmlFor} className="text-xs">{label}</Label>{children}{hint && <p className="text-[11px] leading-relaxed text-muted-foreground">{hint}</p>}</div>
}
function Toggle({ selected, onClick, children, disabled = false }) {
  return <button type="button" aria-pressed={selected} disabled={disabled} onClick={onClick} className={`flex items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${selected ? 'border-foreground/35 bg-muted/50' : 'bg-card text-muted-foreground hover:border-foreground/25'}`}>{children}<span className={`ml-auto flex size-4 items-center justify-center rounded-full border ${selected ? 'border-foreground bg-foreground text-background' : 'border-border'}`}>{selected && <Check className="size-2.5" />}</span></button>
}

// One page: the few choices a team needs to start an agent on its repo, with
// everything else behind Advanced. `replace` edits an existing template.
export function ImageTemplateBuilder(props) {
  const location = useLocation()
  return <ScopedImageTemplateBuilder key={location?.id ?? location?.context ?? 'default'} {...props} />
}

function ScopedImageTemplateBuilder({ initial, draftKey, onClose, onStarted }) {
  const api = useApi()
  const location = useLocation()
  const [recipe, setRecipe] = React.useState(() => newRecipe(initial?.recipe))
  const replace = Boolean(initial?.replace)
  const [baseline] = React.useState(() => initial?.baseline ?? JSON.stringify(newRecipe(initial?.recipe)))
  const [advanced, setAdvanced] = React.useState(Boolean(initial?.advanced))
  const [custom, setCustom] = React.useState(() => !STARTS.some((s) => s.id === newRecipe(initial?.recipe).command))
  const [moreAgents, setMoreAgents] = React.useState(() => Boolean(newRecipe(initial?.recipe).customAgents.length) || AGENTS.some((a) => !a.featured && newRecipe(initial?.recipe).agents.includes(a.id)))
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
    try { sessionStorage.setItem(draftKey, JSON.stringify({ recipe, replace, baseline, advanced })) } catch { /* recovery is best effort */ }
  }, [draftKey, recipe, replace, baseline, advanced])
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

  async function submit(event) {
    event.preventDefault()
    const first = Object.entries(errors)[0] ?? (custom && !recipe.command.trim() ? ['command', 'Enter a start command, or pick one of the options.'] : null)
    if (first) {
      if (['base', 'packages', 'setup', 'environment'].includes(first[0])) setAdvanced(true)
      if (first[0] === 'customAgents') setMoreAgents(true)
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

  return <Dialog open onOpenChange={(open) => { if (!open) requestClose() }}>
    <DialogContent showCloseButton={false} className="max-h-[calc(100svh-2rem)] overflow-hidden p-0 sm:max-w-2xl">
    <form onSubmit={submit} className="flex max-h-[calc(100svh-2rem)] min-h-0 flex-col">
    <DialogHeader className="shrink-0 flex-row items-center justify-between gap-3 border-b bg-card px-5 py-4 sm:px-6">
      <div className="min-w-0">
        <div className="flex items-center gap-2"><DialogTitle className="truncate text-sm">{replace ? `Edit ${recipe.name}` : 'New image template'}</DialogTitle><Tooltip><TooltipTrigger type="button" aria-label="About template access" className="rounded-sm text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"><Info className="size-3.5" /></TooltipTrigger><TooltipContent>Software only. Network, file and credential access come from the security preset you pick at launch, plus the selected agents' own sign-in and model destinations.</TooltipContent></Tooltip></div>
        <DialogDescription className="sr-only">Choose the software and start command for your sandbox image.</DialogDescription>
        <LocationBadge location={location} />
      </div>
      <Button type="button" variant="ghost" size="icon-sm" aria-label="Close template creation" disabled={busy} onClick={requestClose}><X /></Button>
    </DialogHeader>
    <div className="min-h-0 flex-1 overflow-y-auto">
      <fieldset disabled={busy || location?.connected === false} className="mx-auto w-full max-w-2xl min-w-0 space-y-5 px-5 py-5 disabled:opacity-65 sm:px-6">
        <Tabs value={recipe.source} onValueChange={(source) => { patch({ source }); if (source === 'build' && recipe.agents.length > 1) setCustom(false); setError('') }}>
          <TabsList className="w-full"><TabsTrigger value="build" className="text-xs">Build an image</TabsTrigger><TabsTrigger value="image" className="text-xs">Use an existing image</TabsTrigger></TabsList>
        </Tabs>
        {build && <p className="text-[11px] leading-relaxed text-muted-foreground">Images build on the console’s local Docker engine. For an SSH host, the image is built for its architecture and transferred automatically before the template is saved.</p>}
        <Field label="Name" htmlFor="template-name" hint={recipe.name && errors.name ? errors.name : undefined}>
          <Input id="template-name" value={recipe.name} disabled={replace} maxLength={19} onChange={(e) => patch({ name: e.target.value.toLowerCase() })} placeholder="frontend-app" className="font-mono text-xs" autoFocus={!replace} />
        </Field>
        {build ? <>
          <Field label="Agents">
            <div className="grid gap-2 sm:grid-cols-2">{AGENTS.filter((a) => a.featured).map((a) => <Toggle key={a.id} selected={recipe.agents.includes(a.id)} onClick={() => toggleAgent(a.id)}><img src={a.logo} alt="" className="size-5 object-contain" /><span className="font-medium text-foreground">{a.name}</span></Toggle>)}</div>
            <Button type="button" variant="outline" size="sm" aria-expanded={moreAgents} aria-controls="template-more-agents" onClick={() => setMoreAgents((v) => !v)} className="w-full justify-between">
              <span>{moreAgents ? 'Fewer agents' : 'More agents'}{!moreAgents && recipe.customAgents.length > 0 && ' · custom install'}{AGENTS.some((a) => !a.featured && recipe.agents.includes(a.id)) && ` · ${AGENTS.filter((a) => !a.featured && recipe.agents.includes(a.id)).length} selected`}</span>
              <ChevronDown className={`size-3.5 transition-transform ${moreAgents ? 'rotate-180' : ''}`} />
            </Button>
            {moreAgents && <div id="template-more-agents" className="space-y-2">
              <div className="grid gap-2 sm:grid-cols-3">{AGENTS.filter((a) => !a.featured).map((a) => <Toggle key={a.id} selected={recipe.agents.includes(a.id)} onClick={() => toggleAgent(a.id)}><img src={a.logo} alt="" className="size-4 object-contain" /><span className="text-foreground">{a.name}</span></Toggle>)}</div>
              <CustomAgents agents={recipe.customAgents} onChange={(customAgents) => { if (customAgents.length > recipe.customAgents.length) setCustom(false); patch({ customAgents, ...(customAgents.length > recipe.customAgents.length ? { command: '' } : {}) }) }} error={error ? errors.customAgents : undefined} />
            </div>}
          </Field>
          <Field label="Repository" htmlFor="template-repository" hint="Optional. A public HTTPS repository, cloned into /sandbox/project. Private repositories can be cloned after launch.">
            <Input id="template-repository" value={recipe.repository} onChange={(e) => patch({ repository: e.target.value.trim() })} placeholder="https://github.com/your-team/project.git" className="font-mono text-xs" />
          </Field>
          <Field label="Runtimes and tools" hint={[bundled.length && `${bundled.join(' and ')} ${bundled.length > 1 ? 'are' : 'is'} included for the selected agents.`].filter(Boolean).join(' ') || undefined}>
            <div className="grid gap-2 sm:grid-cols-2">{RUNTIMES.map((r) => <Toggle key={r.id} selected={recipe.runtimes.includes(r.id)} onClick={() => toggleRuntime(r.id)}><img src={r.logo} alt="" className="size-5 object-contain" /><span className="font-medium text-foreground">{r.name}</span></Toggle>)}</div>
          </Field>
        </> : <Field label="Image" htmlFor="template-image" hint={local?.error ? local.error : 'An image on the selected Docker engine, or a registry reference Docker is signed in to. OpenShell boots it as is.'}>
          <Input id="template-image" value={recipe.image} onChange={(e) => patch({ image: e.target.value.trim() })} placeholder="ghcr.io/your-team/workspace:latest" className="font-mono text-xs" />
          {local?.images?.length > 0 && <SelectField aria-label="Choose an available image" value={local.images.some((i) => i.reference === recipe.image) ? recipe.image : ''} onChange={(e) => patch({ image: e.target.value })} className="w-full text-xs">
            <option value="" disabled>Choose an available image</option>
            {local.images.map((i) => <option key={i.reference} value={i.reference}>{i.reference}</option>)}
          </SelectField>}
        </Field>}
        <SetupPicker autoPrepare preparationContext="template" value={recipe.setups} onChange={(setups) => patch({ setups })} />
        <StartsIn starts={starts} recipe={recipe} custom={custom} setCustom={setCustom} patch={patch} />

        <div className="border-t pt-4">
          <button type="button" aria-expanded={advanced} onClick={() => setAdvanced((v) => !v)} className="flex items-center gap-1.5 rounded text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
            <ChevronDown className={`size-3.5 transition-transform ${advanced ? '' : '-rotate-90'}`} />Advanced
          </button>
          {advanced && <BlurFade duration={0.15} offset={0} blur="0px" className="mt-5 space-y-6">
            {build && <div className="grid gap-6">
              <Field label="Operating system" htmlFor="template-base">
                <SelectField id="template-base" value={recipe.base} onChange={(e) => patch({ base: e.target.value })} className="w-full text-xs">{BASES.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</SelectField>
              </Field>
              <PackageInput packages={recipe.packages} onChange={(packages) => patch({ packages })} />
            </div>}
            {build && <Field label="Setup commands" htmlFor="template-setup" hint={`Run with bash in ${recipe.repository ? '/sandbox/project' : '/sandbox'} as the sandbox user, at build time. A failing command stops the build.`}>
              <Textarea id="template-setup" value={recipe.setup} onChange={(e) => patch({ setup: e.target.value })} rows={5} placeholder={recipe.runtimes.includes('python') ? 'pip install -r requirements.txt' : 'npm ci'} className="font-mono text-xs" spellCheck={false} />
            </Field>}
            <Field label="Environment variables" hint="Non-secret values, stored in the OpenShell template. Attach credentials through Secrets when you launch.">
              {recipe.environment.map((e, i) => <div key={i} className="flex gap-2">
                <Input aria-label={`Variable ${i + 1} name`} className="min-w-0 flex-1 font-mono text-xs" value={e.name} onChange={(ev) => patch({ environment: recipe.environment.map((x, j) => i === j ? { ...x, name: ev.target.value } : x) })} placeholder="NODE_ENV" />
                <Input aria-label={`Variable ${i + 1} value`} className="min-w-0 flex-1 font-mono text-xs" value={e.value} onChange={(ev) => patch({ environment: recipe.environment.map((x, j) => i === j ? { ...x, value: ev.target.value } : x) })} placeholder="development" />
                <Button type="button" variant="ghost" size="icon" aria-label={`Remove variable ${i + 1}`} onClick={() => patch({ environment: recipe.environment.filter((_, j) => j !== i) })}><Trash2 /></Button>
              </div>)}
              <Button type="button" variant="outline" size="sm" className="justify-self-start" disabled={recipe.environment.length >= 40} onClick={() => patch({ environment: [...recipe.environment, { name: '', value: '' }] })}><Plus />Add variable</Button>
            </Field>
            {build && <Button type="button" variant="outline" size="sm" onClick={() => setCodeOpen(true)}><FileCode2 />View Dockerfile</Button>}
          </BlurFade>}
        </div>
        <div className="flex gap-3 rounded-lg border bg-muted/30 p-3"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" /><p className="text-[11px] leading-relaxed text-muted-foreground">Software only. Network, file and credential access come from the policy you pick at launch, plus the selected agents' own sign-in and model destinations.</p></div>
        {error && <p role="alert" className="whitespace-pre-wrap rounded-md border border-red-200 bg-red-50/60 p-3 text-xs text-red-700">{error}</p>}
      </fieldset>
    </div>
    {progress && <p role="status" className="border-t px-5 py-3 text-xs text-muted-foreground sm:px-6">{progress}</p>}
    <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t bg-card px-5 py-3 sm:px-6">
      {replace && <p className="mr-auto flex items-center gap-1.5 text-[11px] text-muted-foreground"><Info className="size-3.5 shrink-0" />{build ? 'Rebuilding replaces this template.' : 'Saving replaces this template.'} Sandboxes already running from it keep their current image.</p>}
      <Button type="button" variant="ghost" disabled={busy && !preparing} onClick={() => preparing ? preparation.current?.abort() : requestClose()}>{preparing ? "Cancel preparation" : "Cancel"}</Button>
      <Button type="submit" className={action} disabled={busy || location?.connected === false}>{busy ? <Spinner /> : <Package />}{preparing ? 'Preparing MCPs…' : build ? (replace ? 'Rebuild template' : 'Build template') : 'Save template'}</Button>
    </footer>
    <Dialog open={codeOpen} onOpenChange={setCodeOpen}><DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>Generated Dockerfile</DialogTitle><DialogDescription>Setup commands are added as a separate build-context file.</DialogDescription></DialogHeader><pre className="overflow-x-auto rounded-md border bg-muted/30 p-4 font-mono text-[11px] leading-relaxed">{build ? dockerfileFor(recipe) : ''}</pre><Button type="button" variant="outline" onClick={exportDockerfile}><Download />Download Dockerfile</Button></DialogContent></Dialog>
    <Dialog open={leaveOpen} onOpenChange={setLeaveOpen}><DialogContent><DialogHeader><DialogTitle>Discard this template?</DialogTitle><DialogDescription>Your changes haven’t been built yet.</DialogDescription></DialogHeader><div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setLeaveOpen(false)}>Keep editing</Button><Button type="button" variant="destructive" onClick={onClose}>Discard</Button></div></DialogContent></Dialog>
  </form>
    </DialogContent>
  </Dialog>
}

function StartsIn({ starts, recipe, custom, setCustom, patch }) {
  const shellOnly = requiresShell(recipe)
  const options = shellOnly ? STARTS.filter((s) => s.id === '') : starts
  return <Field label="Starts in" hint={shellOnly ? 'Multiple agents are installed. Start in Shell to run any of them.' : custom ? 'Runs through /bin/bash as the sandbox’s main process.' : 'Opens as a session you connect to. Exiting it keeps the sandbox running.'}>
    <div role="group" aria-label="Starts in" className="grid grid-cols-1 gap-2 min-[400px]:grid-cols-2 sm:grid-cols-3">
      {options.map((option) => {
        const agent = AGENTS.find((a) => a.command === option.id)
        return <Toggle key={option.id} disabled={shellOnly} selected={shellOnly || (!custom && recipe.command === option.id)} onClick={() => { setCustom(false); patch({ command: option.id }) }}>
          {agent ? <img src={agent.logo} alt="" className="size-4 object-contain" /> : <Terminal aria-hidden="true" className="size-4" />}
          <span>{option.name}</span>
        </Toggle>
      })}
      {!shellOnly && <Toggle selected={custom} onClick={() => { if (!custom) { setCustom(true); patch({ command: '' }) } }}><FileCode2 aria-hidden="true" className="size-4" /><span>Custom</span></Toggle>}
    </div>
    {!shellOnly && custom && <Input aria-label="Start command" value={recipe.command} onChange={(e) => patch({ command: e.target.value })} placeholder="npm run dev" className="font-mono text-xs" />}
  </Field>
}

function PackageInput({ packages, onChange }) {
  const [draft, setDraft] = React.useState('')
  const input = React.useRef(null)
  function add() {
    const next = splitPackages(draft)
    if (next.length) onChange([...new Set([...packages, ...next])])
    setDraft('')
  }
  return <Field label="System packages" htmlFor="template-packages" hint="Type a package and press Enter or Add. Paste multiple names separated by spaces, commas or new lines.">
    <div className="rounded-lg border bg-card p-3">
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
        }} placeholder="e.g. jq, unzip, build-essential" className="min-w-0 flex-1 font-mono text-xs" autoComplete="off" spellCheck={false} />
        <Button type="button" variant="outline" size="sm" onClick={() => { add(); input.current?.focus() }}><Plus />Add</Button>
      </div>
    </div>
  </Field>
}

function CustomAgents({ agents, onChange, error }) {
  return <div className="space-y-2 pt-2">
    <Label htmlFor="custom-agent-install" className="text-xs">Install another agent</Label>
    <div className="flex items-start gap-2 rounded-lg border bg-muted/20 px-3 py-1 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30">
      <Terminal aria-hidden="true" className="mt-2 size-3.5 shrink-0 text-muted-foreground" />
      <Textarea id="custom-agent-install" value={agents.map((agent) => agent.install).join('\n')} onChange={(e) => onChange(e.target.value.trim() ? [{ name: 'Custom agent', install: e.target.value }] : [])} rows={1} maxLength={6000} spellCheck={false} autoComplete="off" placeholder="Paste an agent install command…" className="min-h-8 resize-none rounded-none border-0 bg-transparent px-0 py-1.5 font-mono text-xs leading-5 focus-visible:ring-0 md:text-xs" aria-invalid={Boolean(error)} />
    </div>
    {error && <p role="alert" className="text-[11px] text-destructive">{error}</p>}
  </div>
}
