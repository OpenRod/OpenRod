import * as React from 'react'
import { ArrowLeft, Check, ChevronDown, ChevronRight, Download, FileCode2, Info, Package, Plus, ShieldCheck, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Spinner } from '@/components/ui/spinner'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { api } from '@/lib/api'
import { AGENTS, BASES, PENDING_RECIPE_KEY, RUNTIMES, STARTS, dockerfileFor, newRecipe, recipeErrors, selectedAgents, splitPackages } from '@/lib/image-templates'

const action = 'bg-[var(--action)] text-[var(--action-foreground)] hover:bg-[var(--action)]/90'

function Field({ label, hint, htmlFor, children }) {
  return <div className="grid content-start gap-2"><Label htmlFor={htmlFor} className="text-xs">{label}</Label>{children}{hint && <p className="text-[11px] leading-relaxed text-muted-foreground">{hint}</p>}</div>
}
function Toggle({ selected, onClick, children }) {
  return <button type="button" aria-pressed={selected} onClick={onClick} className={`flex items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${selected ? 'border-foreground/35 bg-muted/50' : 'bg-card text-muted-foreground hover:border-foreground/25'}`}>{children}<span className={`ml-auto flex size-4 items-center justify-center rounded-full border ${selected ? 'border-foreground bg-foreground text-background' : 'border-border'}`}>{selected && <Check className="size-2.5" />}</span></button>
}

// One page: the few choices a team needs to start an agent on its repo, with
// everything else behind Advanced. `replace` edits an existing template.
export function ImageTemplateBuilder({ initial, onClose, onStarted }) {
  const [recipe, setRecipe] = React.useState(() => newRecipe(initial?.recipe))
  const replace = Boolean(initial?.replace)
  const [baseline] = React.useState(() => initial?.baseline ?? JSON.stringify(newRecipe(initial?.recipe)))
  const [advanced, setAdvanced] = React.useState(Boolean(initial?.advanced))
  const [custom, setCustom] = React.useState(() => !STARTS.some((s) => s.id === newRecipe(initial?.recipe).command))
  const [moreAgents, setMoreAgents] = React.useState(() => AGENTS.some((a) => !a.featured && newRecipe(initial?.recipe).agents.includes(a.id)))
  const [error, setError] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [local, setLocal] = React.useState(null)
  const [codeOpen, setCodeOpen] = React.useState(false)
  const [leaveOpen, setLeaveOpen] = React.useState(false)
  const build = recipe.source === 'build'
  const patch = (value) => setRecipe((r) => ({ ...r, ...value }))
  const dirty = JSON.stringify(recipe) !== baseline
  const errors = recipeErrors(recipe)
  React.useEffect(() => {
    try { sessionStorage.setItem(PENDING_RECIPE_KEY, JSON.stringify({ recipe, replace, baseline, advanced })) } catch { /* recovery is best effort */ }
  }, [recipe, replace, baseline, advanced])
  React.useEffect(() => { api.localImages().then(setLocal).catch((e) => setLocal({ images: [], error: e.message })) }, [])
  React.useEffect(() => {
    const prevent = (event) => { if (dirty) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', prevent)
    return () => window.removeEventListener('beforeunload', prevent)
  }, [dirty])

  // The sandbox starts in the first agent installed, unless someone chose otherwise.
  function toggleAgent(id) {
    const agents = recipe.agents.includes(id) ? recipe.agents.filter((a) => a !== id) : AGENTS.filter((a) => a.id === id || recipe.agents.includes(a.id)).map((a) => a.id)
    const automatic = !custom && (recipe.command === '' ? recipe.agents.length === 0 : AGENTS.some((a) => a.command === recipe.command))
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
      if (['base', 'packages', 'setup', 'environment', 'command'].includes(first[0])) setAdvanced(true)
      setError(first[1]); return
    }
    setBusy(true); setError('')
    try { onStarted(await api.buildImageTemplate(recipe, replace)) } catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  function exportDockerfile() {
    const url = URL.createObjectURL(new Blob([dockerfileFor(recipe)], { type: 'text/plain' }))
    const a = document.createElement('a'); a.href = url; a.download = 'Dockerfile'; a.click(); URL.revokeObjectURL(url)
  }

  return <form onSubmit={submit} className="flex h-[calc(100svh-3.5rem)] min-h-0 flex-col">
    <div className="flex items-center gap-3 border-b bg-card px-4 py-3 sm:px-8">
      <Button type="button" variant="ghost" size="icon-sm" aria-label="Back to templates" disabled={busy} onClick={() => dirty ? setLeaveOpen(true) : onClose()}><ArrowLeft /></Button>
      <p className="min-w-0 truncate text-[13px] font-medium">{replace ? `Edit ${recipe.name}` : 'New image template'}</p>
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto">
      <fieldset disabled={busy} className="mx-auto w-full max-w-2xl min-w-0 space-y-6 px-5 py-8 disabled:opacity-65 sm:px-10">
        <Tabs value={recipe.source} onValueChange={(source) => { patch({ source }); setError('') }}>
          <TabsList className="w-full"><TabsTrigger value="build" className="text-xs">Build an image</TabsTrigger><TabsTrigger value="image" className="text-xs">Use an existing image</TabsTrigger></TabsList>
        </Tabs>
        <Field label="Name" htmlFor="template-name" hint={replace ? 'The name stays the same. Duplicate the template to use a new one.' : 'Lowercase letters, digits and dashes, up to 19.'}>
          <Input id="template-name" value={recipe.name} disabled={replace} maxLength={19} onChange={(e) => patch({ name: e.target.value.toLowerCase() })} placeholder="frontend-app" className="font-mono text-xs" autoFocus={!replace} />
        </Field>
        {build ? <>
          <Field label="Agents" hint="Installed at build time. Attach their credentials when you launch a sandbox.">
            <div className="grid gap-2 sm:grid-cols-2">{AGENTS.filter((a) => a.featured).map((a) => <Toggle key={a.id} selected={recipe.agents.includes(a.id)} onClick={() => toggleAgent(a.id)}><img src={a.logo} alt="" className="size-5 object-contain" /><span className="font-medium text-foreground">{a.name}</span></Toggle>)}</div>
            <button type="button" aria-expanded={moreAgents} onClick={() => setMoreAgents((v) => !v)} className="flex items-center gap-1.5 justify-self-start rounded text-[11px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
              <ChevronRight className={`size-3 transition-transform ${moreAgents ? 'rotate-90' : ''}`} />More agents{!moreAgents && AGENTS.some((a) => !a.featured && recipe.agents.includes(a.id)) && ` · ${AGENTS.filter((a) => !a.featured && recipe.agents.includes(a.id)).length} selected`}
            </button>
            {moreAgents && <>
              <div className="grid gap-2 sm:grid-cols-3">{AGENTS.filter((a) => !a.featured).map((a) => <Toggle key={a.id} selected={recipe.agents.includes(a.id)} onClick={() => toggleAgent(a.id)}><img src={a.logo} alt="" className="size-4 object-contain" /><span className="text-foreground">{a.name}</span></Toggle>)}</div>
              <p className="text-[11px] text-muted-foreground">Another agent? Add its install command to Setup commands under Advanced.</p>
            </>}
          </Field>
          <Field label="Repository" htmlFor="template-repository" hint="Optional. A public HTTPS repository, cloned into /sandbox/project. Private repositories can be cloned after launch.">
            <Input id="template-repository" value={recipe.repository} onChange={(e) => patch({ repository: e.target.value.trim() })} placeholder="https://github.com/your-team/project.git" className="font-mono text-xs" />
          </Field>
          <Field label="Runtime" hint={bundled.length ? `${bundled.join(' and ')} ${bundled.length > 1 ? 'are' : 'is'} included for the selected agents.` : undefined}>
            <div className="grid gap-2 sm:grid-cols-2">{RUNTIMES.map((r) => <Toggle key={r.id} selected={recipe.runtimes.includes(r.id)} onClick={() => toggleRuntime(r.id)}><img src={r.logo} alt="" className="size-5 object-contain" /><span className="font-medium text-foreground">{r.name}</span></Toggle>)}</div>
          </Field>
        </> : <Field label="Image" htmlFor="template-image" hint={local?.error ? local.error : 'An image in local Docker, or a registry reference Docker is signed in to. OpenShell boots it as is.'}>
          <Input id="template-image" list="local-images" value={recipe.image} onChange={(e) => patch({ image: e.target.value.trim() })} placeholder="ghcr.io/your-team/workspace:latest" className="font-mono text-xs" />
          <datalist id="local-images">{(local?.images ?? []).map((i) => <option key={i.reference} value={i.reference}>{i.size}</option>)}</datalist>
        </Field>}
        {!build && <StartsIn starts={starts} recipe={recipe} custom={custom} setCustom={setCustom} patch={patch} />}

        <div className="border-t pt-4">
          <button type="button" aria-expanded={advanced} onClick={() => setAdvanced((v) => !v)} className="flex items-center gap-1.5 rounded text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
            <ChevronDown className={`size-3.5 transition-transform ${advanced ? '' : '-rotate-90'}`} />Advanced
          </button>
          {advanced && <div className="mt-5 space-y-6">
            {build && <StartsIn starts={starts} recipe={recipe} custom={custom} setCustom={setCustom} patch={patch} />}
            {build && <div className="grid gap-6 sm:grid-cols-2">
              <Field label="Operating system" htmlFor="template-base">
                <select id="template-base" value={recipe.base} onChange={(e) => patch({ base: e.target.value })} className="h-8 rounded-md border border-input bg-transparent px-2 text-xs">{BASES.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
              </Field>
              <Field label="System packages" htmlFor="template-packages" hint="apt packages, separated by spaces.">
                <Input id="template-packages" value={recipe.packages.join(' ')} onChange={(e) => patch({ packages: splitPackages(e.target.value) })} onBlur={(e) => patch({ packages: [...new Set(splitPackages(e.target.value))] })} className="font-mono text-xs" />
              </Field>
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
          </div>}
        </div>
        <div className="flex gap-3 rounded-lg border bg-muted/30 p-3"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" /><p className="text-[11px] leading-relaxed text-muted-foreground">Software only. Network, file and credential access come from the security preset you pick at launch.</p></div>
        {error && <p role="alert" className="whitespace-pre-wrap rounded-md border border-red-200 bg-red-50/60 p-3 text-xs text-red-700">{error}</p>}
      </fieldset>
    </div>
    <footer className="flex items-center justify-end gap-2 border-t bg-card px-5 py-3 sm:px-10">
      {replace && <p className="mr-auto flex items-center gap-1.5 text-[11px] text-muted-foreground"><Info className="size-3.5 shrink-0" />{build ? 'Rebuilding replaces this template.' : 'Saving replaces this template.'} Sandboxes already running from it keep their current image.</p>}
      <Button type="button" variant="ghost" disabled={busy} onClick={() => dirty ? setLeaveOpen(true) : onClose()}>Cancel</Button>
      <Button type="submit" className={action} disabled={busy}>{busy ? <Spinner /> : <Package />}{build ? (replace ? 'Rebuild template' : 'Build template') : 'Save template'}</Button>
    </footer>
    <Dialog open={codeOpen} onOpenChange={setCodeOpen}><DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>Generated Dockerfile</DialogTitle><DialogDescription>Setup commands are added as a separate build-context file.</DialogDescription></DialogHeader><pre className="overflow-x-auto rounded-md border bg-muted/30 p-4 font-mono text-[11px] leading-relaxed">{build ? dockerfileFor(recipe) : ''}</pre><Button type="button" variant="outline" onClick={exportDockerfile}><Download />Download Dockerfile</Button></DialogContent></Dialog>
    <Dialog open={leaveOpen} onOpenChange={setLeaveOpen}><DialogContent><DialogHeader><DialogTitle>Discard this template?</DialogTitle><DialogDescription>Your changes haven’t been built yet.</DialogDescription></DialogHeader><div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setLeaveOpen(false)}>Keep editing</Button><Button type="button" variant="destructive" onClick={onClose}>Discard</Button></div></DialogContent></Dialog>
  </form>
}

function StartsIn({ starts, recipe, custom, setCustom, patch }) {
  return <Field label="Starts in" htmlFor="template-start" hint={custom ? 'Runs through /bin/bash as the sandbox’s main process.' : 'Opens as a session you connect to. Exiting it keeps the sandbox running.'}>
    <select id="template-start" value={custom ? 'custom' : recipe.command} onChange={(e) => { const custom = e.target.value === 'custom'; setCustom(custom); patch({ command: custom ? '' : e.target.value }) }} className="h-8 rounded-md border border-input bg-transparent px-2 text-xs">
      {starts.map((s) => <option key={s.name} value={s.id}>{s.name}</option>)}
      <option value="custom">Custom command…</option>
    </select>
    {custom && <Input aria-label="Start command" value={recipe.command} onChange={(e) => patch({ command: e.target.value })} placeholder="npm run dev" className="font-mono text-xs" />}
  </Field>
}
