import * as React from 'react'
import { ArrowLeft, ArrowRight, Box, Check, ChevronRight, Code2, Download, FileCode2, FolderGit2, Layers3, Monitor, Package, Plus, ShieldCheck, Sparkles, SquareTerminal, Trash2, Upload, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { BlurFade } from '@/components/ui/blur-fade'
import { Spinner } from '@/components/ui/spinner'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { api } from '@/lib/api'
import { AGENTS, BASES, PACKAGES, PENDING_RECIPE_KEY, dockerfileFor, newRecipe, recipeErrors, splitPackages } from '@/lib/image-templates'

const action = 'bg-[var(--action)] text-[var(--action-foreground)] hover:bg-[var(--action)]/90'
const steps = [
  { id: 'base', name: 'Starting point', hint: 'Name & operating system', icon: Box, title: 'Start with a foundation', description: 'Choose the environment your tools will live in.' },
  { id: 'tools', name: 'Tools & agents', hint: 'Packages, runtimes & agents', icon: Package, title: 'Make yourself at home', description: 'Install the tools you reach for. Everything here becomes part of your image.' },
  { id: 'workspace', name: 'Workspace', hint: 'Repository & files', icon: FolderGit2, title: 'Bring your starting files', description: 'Add a public repository or small configuration files. This step is optional.' },
  { id: 'setup', name: 'Setup', hint: 'Custom build commands', icon: SquareTerminal, title: 'Finish the setup', description: 'Optional commands run during the image build, as the sandbox user.' },
  { id: 'defaults', name: 'Launch defaults', hint: 'Command & environment', icon: Monitor, title: 'Decide how it starts', description: 'These defaults apply when you create a sandbox from this image template.' },
  { id: 'review', name: 'Review & build', hint: 'One last look', icon: Check, title: 'Your environment, ready to build', description: 'Review the recipe before building it on this computer.' },
]
const importSteps = [
  { ...steps[0], id: 'source', hint: 'Name & image source', title: 'Bring your own image', description: 'Use an image you already have. No need to go through the builder.' },
  steps[4],
  { ...steps[5], name: 'Review & import', title: 'Review your image template', description: 'We’ll check Linux and CPU architecture before saving the image as available.' },
]

function Field({ label, hint, children }) {
  return <div className="grid gap-2"><Label className="text-xs">{label}</Label>{children}{hint && <p className="text-[11px] leading-relaxed text-muted-foreground">{hint}</p>}</div>
}
function Section({ title, description, children }) {
  return <section className="space-y-3"><div><h3 className="text-[13px] font-medium">{title}</h3>{description && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p>}</div>{children}</section>
}
function PackageInput({ label, values, onChange, placeholder }) {
  const [text, setText] = React.useState('')
  function add() { if (!text.trim()) return; onChange([...new Set([...values, ...splitPackages(text)])]); setText('') }
  return <div className="space-y-2"><div className="flex gap-2"><Input aria-label={label} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add() } }} placeholder={placeholder} className="font-mono text-xs" /><Button variant="outline" onClick={add} disabled={!text.trim()}>Add</Button></div>{values.length > 0 && <div className="flex flex-wrap gap-1.5">{values.map((p) => <span key={p} className="flex items-center gap-1 rounded-md border bg-background py-1 pl-2 font-mono text-[11px]">{p}<button aria-label={`Remove ${p}`} onClick={() => onChange(values.filter((v) => v !== p))} className="rounded p-1 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"><X className="size-3" /></button></span>)}</div>}</div>
}
function SelectTile({ selected, onClick, children, className = '' }) {
  return <button type="button" aria-pressed={selected} onClick={onClick} className={`relative rounded-lg border p-4 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring ${selected ? 'border-foreground/35 bg-muted/50' : 'border-border bg-card hover:border-foreground/25'} ${className}`}>{children}<span className={`absolute right-3 top-3 flex size-4 items-center justify-center rounded-full border ${selected ? 'border-[var(--action)] bg-[var(--action)] text-white' : 'border-border'}`}>{selected && <Check className="size-2.5" />}</span></button>
}

export function ImageTemplateBuilder({ initial, onClose, onSaved, onStarted }) {
  const [recipe, setRecipe] = React.useState(() => newRecipe(initial?.recipe))
  const [id, setId] = React.useState(initial?.id)
  const [step, setStep] = React.useState(initial?.step || 0)
  const [error, setError] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [file, setFile] = React.useState(null)
  const [upload, setUpload] = React.useState(null)
  const [local, setLocal] = React.useState(null)
  const [codeOpen, setCodeOpen] = React.useState(false)
  const [leaveOpen, setLeaveOpen] = React.useState(false)
  const [baseline, setBaseline] = React.useState(() => initial?.baseline ?? JSON.stringify(newRecipe(initial?.recipe)))
  const abort = React.useRef(null)
  const heading = React.useRef(null)
  const wizard = recipe.source === 'wizard'
  const flow = wizard ? steps : importSteps
  const current = flow[step]
  const patch = (value) => setRecipe((r) => ({ ...r, ...value }))
  const toggle = (key, value) => {
    const removing = recipe[key].includes(value)
    patch({ [key]: removing ? recipe[key].filter((v) => v !== value) : [...recipe[key], value], ...(key === 'runtimes' && removing ? { [value === 'node' ? 'npm' : 'pip']: [] } : {}) })
  }
  const dirty = JSON.stringify(recipe) !== baseline
  const errors = recipeErrors(recipe)
  React.useEffect(() => {
    try { sessionStorage.setItem(PENDING_RECIPE_KEY, JSON.stringify({ id, recipe, step, baseline })) } catch { /* Save draft remains available if browser storage is full. */ }
  }, [id, recipe, step, baseline])
  React.useEffect(() => { api.localImages().then(setLocal).catch((e) => setLocal({ images: [], error: e.message })) }, [])
  React.useEffect(() => {
    const prevent = (event) => { if (dirty || busy) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', prevent)
    return () => window.removeEventListener('beforeunload', prevent)
  }, [dirty, busy])
  React.useEffect(() => () => abort.current?.abort(), [])
  function go(index) { setStep(index); setError(''); requestAnimationFrame(() => heading.current?.focus()) }
  function next() {
    const relevant = { base: ['name', 'base'], source: ['name', 'image'], tools: ['packages', 'runtimes', 'agents', 'npm', 'pip'], workspace: ['repository', 'files'], setup: ['setup'], defaults: ['command', 'environment'] }[current.id] || []
    const first = relevant.map((key) => errors[key]).find(Boolean)
    if (first) { setError(first); return }
    if (current.id === 'source' && recipe.source === 'archive' && !file) { setError('Choose an image archive to continue.'); return }
    go(step + 1)
  }
  async function save(close = false) {
    setBusy(true); setError('')
    try {
      const saved = await api.saveImageTemplate({ id, recipe })
      setId(saved.id); setBaseline(JSON.stringify(recipe)); onSaved(saved)
      if (close) onClose()
      return saved
    } catch (e) { setError(e.message); return null } finally { setBusy(false) }
  }
  async function build() {
    if (Object.keys(errors).length) { setError(Object.values(errors)[0]); return }
    if (recipe.source === 'archive' && !file) { setError('Choose the image archive again before importing.'); return }
    setBusy(true); setError('')
    try {
      const saved = await api.saveImageTemplate({ id, recipe })
      setId(saved.id); setBaseline(JSON.stringify(recipe)); onSaved(saved)
      let started
      if (recipe.source === 'archive') {
        abort.current = new AbortController(); setUpload(0)
        started = await api.importImageArchive(saved.id, file, setUpload, abort.current.signal)
      } else started = await api.buildImageTemplate(saved.id)
      onStarted(started)
    } catch (e) { setError(e.message) } finally { setBusy(false); setUpload(null); abort.current = null }
  }
  function selectFile(nextFile) {
    if (!nextFile) return
    if (!/\.(tar|tar\.gz|tgz)$/i.test(nextFile.name)) { setError('Choose a Docker image archive (.tar, .tar.gz, or .tgz).'); return }
    if (!nextFile.size || nextFile.size > 4 * 1024 ** 3) { setError('Choose a non-empty archive smaller than 4 GB.'); return }
    setFile(nextFile); setError('')
  }
  function exportDockerfile() {
    const url = URL.createObjectURL(new Blob([dockerfileFor(recipe)], { type: 'text/plain' }))
    const a = document.createElement('a'); a.href = url; a.download = 'Dockerfile'; a.click(); URL.revokeObjectURL(url)
  }

  return <div className="flex h-[calc(100svh-3.5rem)] min-h-0 flex-col">
    <div className="flex flex-wrap items-center gap-3 border-b bg-card px-4 py-3 sm:px-8">
      <Button variant="ghost" size="icon-sm" aria-label="Back to templates" disabled={busy} onClick={() => dirty ? setLeaveOpen(true) : onClose()}><ArrowLeft /></Button>
      <div className="min-w-0"><p className="text-[13px] font-medium">{recipe.name || (wizard ? 'New image template' : 'Import an image')}</p><p className="mt-0.5 text-[11px] text-muted-foreground">{wizard ? 'Guided builder' : 'Existing image'} <span className="px-1.5 text-faint">/</span> Local</p></div>
      <span className="ml-auto text-[11px] text-muted-foreground">{dirty ? 'Unsaved changes' : id ? 'Draft saved' : 'New recipe'}</span>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => save()}>{busy && upload === null ? <Spinner /> : null}Save draft</Button>
    </div>
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <aside className="shrink-0 border-b bg-card/40 p-3 md:w-60 md:border-r md:border-b-0 md:px-4 md:py-7">
        <p className="mb-4 hidden px-3 text-[10px] font-semibold tracking-widest text-faint uppercase md:block">{wizard ? 'Build your environment' : 'Import your environment'}</p>
        <nav aria-label="Template steps" className="flex gap-1 overflow-x-auto md:flex-col">{flow.map((s, i) => <button key={s.id} disabled={busy} aria-current={step === i ? 'step' : undefined} onClick={() => go(i)} className={`flex shrink-0 items-center gap-3 rounded-md px-3 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring ${step === i ? 'bg-accent/65 text-foreground' : 'text-muted-foreground hover:bg-muted'}`}><span className={`flex size-6 shrink-0 items-center justify-center rounded-md border text-[11px] ${step === i ? 'border-foreground/20 bg-card' : 'border-border'}`}>{i + 1}</span><span><span className="block whitespace-nowrap text-xs font-medium">{s.name}</span><span className="mt-1 hidden text-[10px] text-muted-foreground md:block">{s.hint}</span></span></button>)}</nav>
        <div className="mx-3 mt-12 hidden space-y-2 border-t pt-4 md:block"><ShieldCheck className="size-4 text-muted-foreground" /><p className="text-[11px] leading-relaxed text-muted-foreground">Software lives in the image. Access comes from a security preset when you launch.</p></div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl flex-1 px-5 py-8 sm:px-10">
          <BlurFade key={current.id} duration={0.18} offset={3} blur="1px">
            <p className="mb-2 text-[10px] font-medium tracking-widest text-faint uppercase">Step {step + 1} of {flow.length}</p>
            <h2 ref={heading} tabIndex={-1} className="text-[22px] font-semibold tracking-tight outline-none">{current.title}</h2>
            <p className="mt-2 mb-8 max-w-lg text-[13px] leading-relaxed text-muted-foreground">{current.description}</p>
            <fieldset disabled={busy} className="min-w-0 space-y-7 disabled:opacity-65">
              {['base', 'source'].includes(current.id) && <>
                <Field label="Template name"><Input aria-label="Template name" value={recipe.name} maxLength={80} onChange={(e) => patch({ name: e.target.value })} placeholder="e.g. Frontend development" /></Field>
                <Field label="Description" hint="Optional. Help your future self pick the right environment."><Input aria-label="Description" value={recipe.description} maxLength={400} onChange={(e) => patch({ description: e.target.value })} placeholder="What is this environment for?" /></Field>
                {wizard ? <Section title="Operating system"><div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{BASES.map((b) => <SelectTile key={b.id} selected={recipe.base === b.id} onClick={() => patch({ base: b.id })}><span className="mb-5 flex size-9 items-center justify-center rounded-lg border bg-card font-mono text-lg text-muted-foreground"><img src={b.logo} alt="" className="size-6 object-contain" /></span><span className="block text-sm font-medium">{b.name} <span className="ml-1 text-xs font-normal text-muted-foreground">{b.version}</span></span><span className="mt-1.5 block text-[11px] text-muted-foreground">{b.description}</span></SelectTile>)}</div><p className="text-[11px] text-muted-foreground">Linux · {local?.architecture || 'Local architecture'} · /sandbox workspace</p></Section> : <Section title="Image source">
                  <Tabs value={recipe.source} onValueChange={(source) => { patch({ source, image: '' }); setError('') }}><TabsList className="w-full"><TabsTrigger value="local" className="text-xs">Local image</TabsTrigger><TabsTrigger value="registry" className="text-xs">Registry</TabsTrigger><TabsTrigger value="archive" className="text-xs">Upload archive</TabsTrigger></TabsList></Tabs>
                  {recipe.source === 'local' && <Field label="Image on this computer"><select aria-label="Local image" value={recipe.image} onChange={(e) => patch({ image: e.target.value })} className="h-10 w-full rounded-md border bg-card px-3 font-mono text-xs"><option value="">{local ? 'Choose an image…' : 'Reading local images…'}</option>{(local?.images || []).map((i) => <option key={i.reference} value={i.reference}>{i.reference} · {i.size}</option>)}</select>{local?.error && <p role="alert" className="text-xs text-amber-700">{local.error}</p>}{local && !local.error && !local.images.length && <p className="text-xs text-muted-foreground">No local images yet. Use a registry reference or upload an archive.</p>}</Field>}
                  {recipe.source === 'registry' && <Field label="Image reference" hint="Public images or registries you have already signed into with Docker."><Input aria-label="Image reference" className="font-mono text-xs" value={recipe.image} onChange={(e) => patch({ image: e.target.value })} placeholder="ghcr.io/your-team/workspace:latest" /></Field>}
                  {recipe.source === 'archive' && <label onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); selectFile(e.dataTransfer.files[0]) }} className="relative flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed bg-background px-5 py-9 text-center transition-colors hover:border-foreground/30 focus-within:ring-2 focus-within:ring-ring"><Upload className="mb-3 size-6 text-muted-foreground" /><span className="text-xs font-medium">{file ? file.name : 'Drop an image archive here'}</span><span className="mt-2 text-[11px] text-muted-foreground">{file ? `${(file.size / 1024 ** 2).toFixed(1)} MB · Click to replace` : 'or click to browse · .tar, .tar.gz · up to 4 GB'}</span><input type="file" aria-label="Image archive" accept=".tar,.tar.gz,.tgz" className="absolute inset-0 h-full w-full cursor-pointer opacity-0" onChange={(e) => selectFile(e.target.files[0])} /></label>}
                  {recipe.source === 'archive' && <p className="text-[11px] leading-relaxed text-muted-foreground">A Docker image archive from docker save. VM disks and root filesystem archives use different formats.</p>}
                </Section>}
              </>}
              {current.id === 'tools' && <>
                <Section title="System packages"><div className="flex flex-wrap gap-2">{PACKAGES.map((p) => <button key={p} type="button" aria-pressed={recipe.packages.includes(p)} onClick={() => toggle('packages', p)} className={`flex items-center gap-2 rounded-md border px-3 py-2 font-mono text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring ${recipe.packages.includes(p) ? 'border-foreground/25 bg-muted' : 'bg-card text-muted-foreground'}`}>{recipe.packages.includes(p) ? <Check className="size-3" /> : <Plus className="size-3" />}{p}</button>)}</div><PackageInput label="Additional system packages" values={recipe.packages.filter((p) => !PACKAGES.includes(p))} onChange={(v) => patch({ packages: [...recipe.packages.filter((p) => PACKAGES.includes(p)), ...v] })} placeholder="postgresql-client redis-tools" /></Section>
                <Section title="Runtimes"><div className="grid gap-3 sm:grid-cols-2">{[['node', 'Node.js', '22 · includes npm'], ['python', 'Python', 'System version · isolated pip environment']].map(([key, name, desc]) => <SelectTile key={key} selected={recipe.runtimes.includes(key)} onClick={() => toggle('runtimes', key)}><img src={`/logos/templates/${key === 'node' ? 'nodejs' : 'python'}.svg`} alt="" className="mb-3 size-6 object-contain" /><span className="block text-xs font-medium">{name}</span><span className="mt-1 block text-[11px] text-muted-foreground">{desc}</span></SelectTile>)}</div>{recipe.runtimes.includes('node') && <PackageInput label="npm packages" values={recipe.npm} onChange={(npm) => patch({ npm })} placeholder="typescript pnpm" />}{recipe.runtimes.includes('python') && <PackageInput label="Python packages" values={recipe.pip} onChange={(pip) => patch({ pip })} placeholder="requests pandas pytest" />}</Section>
                <Section title="AI agents" description="Install the agent here. Attach its credentials when you launch a sandbox."><div className="grid gap-3 sm:grid-cols-2">{AGENTS.map((a) => <SelectTile key={a.id} selected={recipe.agents.includes(a.id)} onClick={() => toggle('agents', a.id)}><img src={a.logo} alt="" className="mb-3 size-6 object-contain" /><span className="block text-xs font-medium">{a.name}</span><span className="mt-1 block text-[11px] text-muted-foreground">Latest release at build time</span></SelectTile>)}</div>{recipe.agents.includes('codex') && !recipe.runtimes.includes('node') && <p className="text-[11px] text-muted-foreground">Node.js 22 is included for Codex.</p>}</Section>
              </>}
              {current.id === 'workspace' && <>
                <Field label="Public repository" hint="Cloned into /sandbox/project during the build. Private repositories can be added after launch."><Input aria-label="Public repository" value={recipe.repository} onChange={(e) => patch({ repository: e.target.value })} placeholder="https://github.com/your-team/project.git" className="font-mono text-xs" /></Field>
                <Section title="Starting files" description="Small configuration files, relative to the workspace. Keep credentials out of image layers.">{recipe.files.map((f, i) => <div key={i} className="space-y-2 rounded-lg border bg-card p-3"><div className="flex gap-2"><Input aria-label={`File ${i + 1} path`} value={f.path} onChange={(e) => patch({ files: recipe.files.map((x, j) => i === j ? { ...x, path: e.target.value } : x) })} placeholder=".gitignore" className="font-mono text-xs" /><Button variant="ghost" size="icon" aria-label={`Remove file ${i + 1}`} onClick={() => patch({ files: recipe.files.filter((_, j) => j !== i) })}><Trash2 /></Button></div><Textarea aria-label={`File ${i + 1} content`} value={f.content} onChange={(e) => patch({ files: recipe.files.map((x, j) => i === j ? { ...x, content: e.target.value } : x) })} placeholder="File contents" rows={4} className="font-mono text-xs" /></div>)}<Button variant="outline" size="sm" disabled={recipe.files.length >= 20} onClick={() => patch({ files: [...recipe.files, { path: '', content: '' }] })}><Plus />Add file</Button></Section>
              </>}
              {current.id === 'setup' && <><Field label="Setup commands" hint={`Runs with bash in ${recipe.repository ? '/sandbox/project' : '/sandbox'}. A failing command stops the build.`}><div className="overflow-hidden rounded-lg border bg-card"><div className="flex items-center gap-2 border-b bg-muted/50 px-3 py-2 font-mono text-[10px] text-muted-foreground"><SquareTerminal className="size-3" />sandbox · bash</div><Textarea aria-label="Setup commands" value={recipe.setup} onChange={(e) => patch({ setup: e.target.value })} rows={11} placeholder={recipe.runtimes.includes('node') ? 'npm ci\nnpm run build' : '# Optional setup commands'} className="rounded-none border-0 bg-transparent p-4 font-mono text-xs shadow-none" /></div></Field><p className="text-xs leading-relaxed text-muted-foreground">Build commands use the container engine’s network access. The sandbox security preset applies after launch.</p></>}
              {current.id === 'defaults' && <>
                <Section title="Start with"><div className="flex flex-wrap gap-2">{[{ name: 'Shell', command: '' }, ...AGENTS.filter((a) => !wizard || recipe.agents.includes(a.id))].map((a) => <Button key={a.name} variant={recipe.command === a.command ? 'secondary' : 'outline'} size="sm" onClick={() => patch({ command: a.command })}>{recipe.command === a.command && <Check />}{a.name}</Button>)}</div><Input aria-label="Startup command" value={recipe.command} onChange={(e) => patch({ command: e.target.value })} placeholder="Shell (default), or enter a command" className="font-mono text-xs" /><p className="text-[11px] text-muted-foreground">Custom commands run through /bin/bash. Imported images must include the tools you choose.</p></Section>
                <Section title="Environment variables" description="Non-secret values, supplied at launch. Credentials are attached separately through Secrets.">{recipe.environment.map((e, i) => <div key={i} className="flex flex-wrap gap-2"><Input aria-label={`Variable ${i + 1} name`} className="min-w-0 flex-1 font-mono text-xs" value={e.name} onChange={(ev) => patch({ environment: recipe.environment.map((x, j) => i === j ? { ...x, name: ev.target.value } : x) })} placeholder="NODE_ENV" /><Input aria-label={`Variable ${i + 1} value`} className="min-w-0 flex-1 font-mono text-xs" value={e.value} onChange={(ev) => patch({ environment: recipe.environment.map((x, j) => i === j ? { ...x, value: ev.target.value } : x) })} placeholder="development" /><Button variant="ghost" size="icon" aria-label={`Remove variable ${i + 1}`} onClick={() => patch({ environment: recipe.environment.filter((_, j) => j !== i) })}><X /></Button></div>)}<Button variant="outline" size="sm" onClick={() => patch({ environment: [...recipe.environment, { name: '', value: '' }] })}><Plus />Add variable</Button></Section>
                <div className="flex gap-3 rounded-lg border bg-muted/30 p-4"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" /><div><p className="text-xs font-medium">Security is chosen at launch</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">The same image can run with different security presets. Organization and group policies still apply. This template grants no file, network, or credential access.</p></div></div>
              </>}
              {current.id === 'review' && <>
                <div className="overflow-hidden rounded-lg border bg-card"><div className="flex items-center gap-3 border-b p-5"><span className="flex size-10 items-center justify-center rounded-lg border bg-background"><Layers3 className="size-5 text-muted-foreground" /></span><div><h3 className="text-sm font-medium">{recipe.name || 'Untitled template'}</h3><p className="mt-1 text-xs text-muted-foreground">{recipe.description || (wizard ? 'Built on this computer' : 'Imported to this computer')}</p></div></div><dl className="divide-y px-5">{[['Source', wizard ? recipe.base : recipe.source === 'archive' ? file?.name || 'Choose archive again' : recipe.image], ...(wizard ? [['System packages', recipe.packages.join(', ') || 'Essentials only'], ['Runtimes', recipe.runtimes.join(', ') || 'None selected'], ['Agents', recipe.agents.map((id) => AGENTS.find((a) => a.id === id)?.name).join(', ') || 'None'], ['Workspace', recipe.repository || '/sandbox']] : []), ['Starts with', recipe.command || 'Shell'], ['Variables', `${recipe.environment.length} non-secret`], ['Security preset', 'Choose when creating a sandbox']].map(([label, value]) => <div key={label} className="grid grid-cols-[110px_1fr] gap-4 py-3 text-xs"><dt className="text-muted-foreground">{label}</dt><dd className="min-w-0 break-words font-medium">{value}</dd></div>)}</dl></div>
                {Object.keys(errors).length > 0 && <div className="space-y-1 rounded-md border border-amber-200 bg-amber-50/50 p-3 text-xs text-amber-800">{Object.entries(errors).map(([key, message]) => <p key={key}>{message}</p>)}</div>}
                {wizard && (recipe.npm.length > 0 || recipe.pip.length > 0 || recipe.files.length > 0 || recipe.setup) && <div className="space-y-3 text-xs">{recipe.npm.length > 0 && <p><span className="text-muted-foreground">npm · </span>{recipe.npm.join(', ')}</p>}{recipe.pip.length > 0 && <p><span className="text-muted-foreground">pip · </span>{recipe.pip.join(', ')}</p>}{recipe.files.length > 0 && <p><span className="text-muted-foreground">Files · </span>{recipe.files.map((f) => f.path).join(', ')}</p>}{recipe.setup && <details><summary className="cursor-pointer text-muted-foreground">Setup commands</summary><pre className="mt-2 whitespace-pre-wrap rounded-md border bg-card p-3 font-mono text-[11px]">{recipe.setup}</pre></details>}</div>}
                {wizard && <Button variant="outline" size="sm" onClick={() => setCodeOpen(true)}><FileCode2 />View Dockerfile</Button>}
                <p className="text-[11px] leading-relaxed text-muted-foreground">{wizard ? 'The first build may take a few minutes. Later builds reuse cached layers.' : 'Linux and architecture checks do not test the image’s startup command or OpenShell runtime compatibility.'} Images stay local. Nothing is published to a registry.</p>
              </>}
            </fieldset>
          </BlurFade>
          {error && <p role="alert" className="mt-5 whitespace-pre-wrap rounded-md border border-red-200 bg-red-50/60 p-3 text-xs text-red-700">{error}</p>}
          {upload !== null && <div className="mt-5 space-y-2" role="status"><p className="text-xs text-muted-foreground">{upload === 100 ? 'Archive uploaded. Loading into Docker…' : `Uploading archive · ${upload}%`}</p><progress max="100" value={upload} className="h-1 w-full accent-[var(--action)]" /><Button variant="ghost" size="sm" onClick={() => abort.current?.abort()}>Cancel upload</Button></div>}
        </div>
        <footer className="sticky bottom-0 flex items-center gap-3 border-t bg-card px-5 py-4 sm:px-10"><span className="hidden text-[11px] text-muted-foreground sm:block"><Monitor className="mr-1.5 inline size-3" />Local environment</span><div className="ml-auto flex gap-2"><Button variant="ghost" disabled={step === 0 || busy} onClick={() => go(step - 1)}>Back</Button>{step < flow.length - 1 ? <Button className={action} disabled={busy} onClick={next}>Continue<ArrowRight /></Button> : <Button className={action} disabled={busy || Object.keys(errors).length > 0} onClick={build}>{busy ? <Spinner /> : wizard ? <Package /> : <Download />}{wizard ? 'Build image' : 'Import image'}</Button>}</div></footer>
      </div>
    </div>
    <Dialog open={codeOpen} onOpenChange={setCodeOpen}><DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>Generated Dockerfile</DialogTitle><DialogDescription>Setup commands and starting files are added as separate build-context files.</DialogDescription></DialogHeader><pre className="overflow-x-auto rounded-md border bg-muted/30 p-4 font-mono text-[11px] leading-relaxed">{wizard ? dockerfileFor(recipe) : ''}</pre><Button variant="outline" onClick={exportDockerfile}><Download />Download Dockerfile</Button></DialogContent></Dialog>
    <Dialog open={leaveOpen} onOpenChange={setLeaveOpen}><DialogContent><DialogHeader><DialogTitle>Keep this draft?</DialogTitle><DialogDescription>Save your changes to continue building later.</DialogDescription></DialogHeader><div className="flex justify-end gap-2"><Button variant="ghost" disabled={busy} onClick={onClose}>Discard changes</Button><Button className={action} disabled={busy} onClick={() => save(true)}>Save & leave</Button></div></DialogContent></Dialog>
  </div>
}
