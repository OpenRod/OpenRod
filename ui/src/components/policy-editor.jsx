import * as React from 'react'
import { ChevronRight, Pencil, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { SelectField } from '@/components/ui/select-field'
import { Spinner } from '@/components/ui/spinner'
import { RuleEditor, describeRule } from '@/components/rule-editor'
import { composeTemplate } from '../../shared/policy-templates.js'
import { COMMON_FOLDERS, DESTINATION_PROGRAMS, filesystemPreset, folderAccess, setFolderAccess, availablePolicyId, destinationRule } from '@/lib/policy-editor'
import { useApi, useLocation } from '@/lib/location-context'

const selectClass = 'h-8 max-w-full rounded-md border border-input bg-background px-2 text-xs'

function Disclosure({ title, children, open }) {
  return <details className="group/disclosure border-t pt-3" open={open}>
    <summary className="flex cursor-pointer list-none items-center gap-2 rounded-sm text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
      <ChevronRight className="size-3.5 text-muted-foreground transition-transform group-open/disclosure:rotate-90" />{title}
    </summary>
    <div className="mt-3 space-y-3">{children}</div>
  </details>
}

function AccessChoices({ templates, value = [], onChange }) {
  const additions = templates.filter(item => item.kind === 'access')
  const github = additions.filter(item => ['github-read', 'github-write'].includes(item.id))
  const selectedGithub = value.find(id => github.some(item => item.id === id)) || ''
  const other = additions.filter(item => !github.includes(item))
  return <div className="divide-y rounded-lg border">
    {github.length > 0 && <div className="space-y-1 px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label htmlFor="policy-github" className="text-xs">GitHub</Label>
        <SelectField id="policy-github" value={selectedGithub} className={selectClass} onChange={event => onChange([...value.filter(id => !['github-read', 'github-write'].includes(id)), ...(event.target.value ? [event.target.value] : [])])}>
          <option value="">No additional access</option>
          {github.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </SelectField>
      </div>
      <p className="text-[11px] text-muted-foreground">{selectedGithub ? github.find(item => item.id === selectedGithub)?.description : 'Choose access for repositories and the GitHub API.'}</p>
    </div>}
    {other.length > 0 && <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
      <span className="text-xs">Package downloads</span>
      <div className="flex flex-wrap gap-1.5">{other.map(item => <Button key={item.id} type="button" variant="outline" size="sm" aria-pressed={value.includes(item.id)} title={`${item.description} Destinations: ${item.rules.flatMap(rule => rule.endpoints.map(endpoint => endpoint.host)).join(', ')}`} className={value.includes(item.id) ? 'border-foreground/25 bg-accent' : 'text-muted-foreground'} onClick={() => onChange(value.includes(item.id) ? value.filter(id => id !== item.id) : [...value, item.id])}>{item.id === 'python-packages' ? 'Python' : item.id === 'node-packages' ? 'Node.js' : item.name}</Button>)}</div>
    </div>}
    {!additions.length && <p className="p-3 text-xs text-muted-foreground">No saved access options. Add a destination below.</p>}
  </div>
}

function FolderList({ filesystem, onChange, system = false }) {
  const [customRows, setCustomRows] = React.useState(new Set())
  const rows = [...filesystem.readOnly.map(path => ({ path, access: 'readOnly' })), ...filesystem.readWrite.map(path => ({ path, access: 'readWrite' }))]
  function update(index, patch) {
    const next = rows.map((row, i) => i === index ? { ...row, ...patch } : row)
    onChange({ ...filesystem, readOnly: next.filter(row => row.access === 'readOnly').map(row => row.path), readWrite: next.filter(row => row.access === 'readWrite').map(row => row.path) })
  }
  function remove(index) {
    const next = rows.filter((_, i) => i !== index)
    onChange({ ...filesystem, readOnly: next.filter(row => row.access === 'readOnly').map(row => row.path), readWrite: next.filter(row => row.access === 'readWrite').map(row => row.path) })
  }
  const systemPaths = new Set([...filesystemPreset('standard').readOnly, '/dev/null'])
  const entries = rows.map((row, index) => ({ row, index }))
  const renderRow = ({ row, index }) => <div key={index} className="flex flex-wrap items-center gap-2 rounded-md border p-2">
      <SelectField aria-label={`Folder ${index + 1}`} value={!customRows.has(index) && COMMON_FOLDERS.some(([path]) => path === row.path) ? row.path : 'custom'} onChange={event => { setCustomRows(current => { const next = new Set(current); if (event.target.value === 'custom') next.add(index); else next.delete(index); return next }); update(index, { path: event.target.value === 'custom' ? '' : event.target.value }) }} className={`${selectClass} min-w-36 flex-1`}>
        {COMMON_FOLDERS.map(([path, label]) => <option key={path} value={path}>{label} ({path})</option>)}
        <option value="custom">Custom path</option>
      </SelectField>
      <SelectField aria-label={`Access for folder ${index + 1}`} value={row.access} onChange={event => update(index, { access: event.target.value })} className={selectClass}>
        <option value="readOnly">Read only</option><option value="readWrite">Read & write</option>
      </SelectField>
      <Button variant="ghost" size="icon-xs" aria-label={`Remove folder ${index + 1}`} onClick={() => remove(index)}><Trash2 /></Button>
      {(customRows.has(index) || !COMMON_FOLDERS.some(([path]) => path === row.path)) && <Input aria-label={`Custom folder path ${index + 1}`} value={row.path} onChange={event => { setCustomRows(current => new Set(current).add(index)); update(index, { path: event.target.value }) }} placeholder="/data/project" className="h-8 w-full font-mono text-xs" />}
    </div>
  return <div className="space-y-2">
    {entries.filter(({ row }) => system ? systemPaths.has(row.path) : !systemPaths.has(row.path) && !['/sandbox', '/tmp'].includes(row.path)).map(renderRow)}
    {!system && <Button variant="outline" size="sm" onClick={() => onChange({ ...filesystem, readOnly: [...filesystem.readOnly, ''] })}><Plus />Add folder</Button>}
  </div>
}

function DestinationDialog({ open, onClose, onAdd, onAdvanced, rules }) {
  const [host, setHost] = React.useState('')
  const [access, setAccess] = React.useState('read-only')
  const [program, setProgram] = React.useState('curl')
  const [error, setError] = React.useState(null)
  React.useEffect(() => { if (open) { setHost(''); setAccess('read-only'); setProgram('curl'); setError(null) } }, [open])
  const chosen = DESTINATION_PROGRAMS.find(item => item.id === program)
  function spec() { return destinationRule({ host, access, program }, rules) }
  return <Dialog open={open} onOpenChange={value => { if (!value) onClose() }}>
    <DialogContent className="sm:max-w-md">
      <DialogHeader><DialogTitle>Add destination</DialogTitle><DialogDescription>Allow selected programs to reach a website or API over HTTPS.</DialogDescription></DialogHeader>
      <form className="grid gap-4" onSubmit={event => { event.preventDefault(); try { onAdd(spec()); onClose() } catch (e) { setError(e.message) } }}>
        <div className="grid gap-1.5"><Label htmlFor="policy-destination" className="text-xs">Destination</Label><Input id="policy-destination" value={host} onChange={event => setHost(event.target.value)} placeholder="docs.example.com" className="text-xs" required autoFocus /></div>
        <div className="grid gap-1.5"><Label htmlFor="destination-access" className="text-xs">Access</Label><SelectField id="destination-access" value={access} onChange={event => setAccess(event.target.value)} className={selectClass}><option value="read-only">Read only</option><option value="read-write">Read & write</option></SelectField></div>
        <p className="text-xs text-muted-foreground">Allowed programs: {chosen.name}. Uses HTTPS on port 443.</p>
        <Disclosure title="Advanced settings">
          <div className="grid gap-1.5"><Label htmlFor="destination-programs" className="text-xs">Which programs can connect?</Label><SelectField id="destination-programs" value={program} onChange={event => setProgram(event.target.value)} className={selectClass}>{DESTINATION_PROGRAMS.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</SelectField></div>
          <p className="break-all font-mono text-[10px] text-muted-foreground">{chosen.binaries.join(', ')}</p>
          {program !== 'curl' && <p className="text-[11px] text-muted-foreground">Applies to all code using these interpreter paths.</p>}
          <Button type="button" variant="outline" size="sm" onClick={() => { try { onAdvanced(spec()); onClose() } catch (e) { setError(e.message) } }}>Configure ports and request rules</Button>
        </Disclosure>
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit">Add destination</Button></div>
      </form>
    </DialogContent>
  </Dialog>
}

export function PolicyEditor(props) {
  const location = useLocation()
  return <ScopedPolicyEditor key={location?.id ?? location?.context ?? 'default'} {...props} />
}

function ScopedPolicyEditor({ open, initial, onClose, onSaved, onDelete, knownPrograms, templates }) {
  const api = useApi()
  const [t, setT] = React.useState(null)
  const [source, setSource] = React.useState('')
  const [rule, setRule] = React.useState(null)
  const [adding, setAdding] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState(null)
  React.useEffect(() => {
    if (!open || !initial) return
    setT(structuredClone(initial)); setSource(''); setRule(null); setAdding(false); setError(null)
  }, [open, initial])
  if (!t || !initial) return null
  const accessOnly = t.kind === 'access'
  let combined, compositionError
  try { combined = composeTemplate(t, [], templates.map(item => item.id === t.id && accessOnly ? t : item)) } catch (e) { compositionError = e.message }
  function update(patch) { setT(current => ({ ...current, ...patch })); setError(null) }
  function addRule(spec) {
    const rules = rule?.index >= 0 ? t.rules.map((item, index) => index === rule.index ? spec : item) : [...t.rules, spec]
    if (new Set(rules.map(item => item.name)).size !== rules.length) throw new Error('A destination rule already uses that name.')
    update({ rules })
  }
  async function save() {
    if (busy || !t.name.trim() || compositionError) return
    setBusy(true); setError(null)
    try {
      const saved = await api.saveTemplate({ ...t, name: t.name.trim(), id: initial.idLocked ? t.id : availablePolicyId(t.name, templates) })
      toast.success(`Saved ${saved.name}`); onSaved(); onClose()
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  return <Dialog open={open} onOpenChange={value => { if (!value && !busy) onClose() }}>
    <DialogContent className="flex max-h-[90svh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[580px]" showCloseButton={!busy} aria-describedby="policy-editor-help">
      <div className="shrink-0 border-b border-border px-5 pt-4 pb-3">
        <DialogTitle className="text-[14px]">{initial.idLocked ? 'Edit policy' : 'Create policy'}</DialogTitle>
        <DialogDescription id="policy-editor-help" className="mt-0.5 text-[11px]">Choose what your sandbox can access.</DialogDescription>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-5">
        <fieldset disabled={busy} className="min-w-0 space-y-3">
          <div className="grid gap-1.5"><Label htmlFor="tpl-name" className="text-xs">Policy name</Label><Input id="tpl-name" value={t.name} onChange={event => update({ name: event.target.value })} placeholder="Frontend development" className="text-xs" autoFocus /></div>
          <div className="flex flex-wrap items-start gap-x-5 gap-y-2">
          {!initial.idLocked && <details className="text-xs"><summary className="w-fit cursor-pointer text-muted-foreground">Start from an existing policy</summary>
            <SelectField aria-label="Start from an existing policy" value={source} className={`${selectClass} mt-2 w-full`} onChange={event => {
              const selected = templates.find(item => item.id === event.target.value)
              if (!selected) return
              setSource(selected.id)
              update({ description: selected.description, filesystem: structuredClone(selected.filesystem), landlock: selected.landlock, rules: structuredClone(selected.rules), accessTemplates: [...(selected.accessTemplates || [])], ingress: structuredClone(selected.ingress || []) })
            }}><option value="" disabled>Choose a policy</option>{templates.filter(item => item.kind !== 'access').map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</SelectField>
            <p className="mt-1 text-[11px] text-muted-foreground">Copies its permissions into this draft. The original policy stays unchanged.</p>
          </details>}
          <details className="text-xs"><summary className="w-fit cursor-pointer text-muted-foreground">Description (optional)</summary><Textarea aria-label="Description" rows={2} value={t.description} onChange={event => update({ description: event.target.value })} className="mt-2 text-xs" /></details>
          </div>
          <section className="space-y-2">
            <h3 className="text-xs font-medium">Network</h3>
            <p className="text-[11px] text-muted-foreground">Selected agents receive their required connections at launch. Other destinations need an explicit rule.</p>
            {!accessOnly && <AccessChoices templates={templates} value={t.accessTemplates} onChange={accessTemplates => update({ accessTemplates })} />}
            {accessOnly && <p className="text-xs text-muted-foreground">This option adds network access to the base policy selected at launch.</p>}
            {t.rules.map((item, index) => <div key={`${index}-${item.name}`} className="flex items-start gap-2 rounded-md border p-3">
              <div className="min-w-0 flex-1"><p className="break-words text-xs">{item.endpoints.map(endpoint => endpoint.host).join(', ')}</p><p className="mt-1 text-[11px] text-muted-foreground">{describeRule(item)}</p></div>
              <Button size="icon-xs" variant="ghost" aria-label={`Edit ${item.name}`} onClick={() => setRule({ index, spec: item })}><Pencil /></Button>
              <Button size="icon-xs" variant="ghost" aria-label={`Remove ${item.name}`} onClick={() => update({ rules: t.rules.filter((_, i) => i !== index) })}><Trash2 /></Button>
            </div>)}
            <Button variant="outline" size="sm" onClick={() => { setRule(null); setAdding(true) }}><Plus />Add website or API</Button>
          </section>
          <Disclosure title="See included access">
            <p className="text-[11px] text-muted-foreground">Agent connections depend on the agents selected during sandbox creation. Exact destinations and programs are shown there. Attached secrets and shared rules can add access; organization blocks still apply.</p>
            {combined?.rules.length > 0 && <ul className="space-y-2">{combined.rules.map(item => <li key={item.name} className="text-[11px]"><p>{describeRule(item)}</p><p className="mt-1 break-all font-mono text-[10px] text-muted-foreground">{item.binaries.join(', ')}</p></li>)}</ul>}
          </Disclosure>
          {!accessOnly && <section className="space-y-2 border-t pt-3">
            <h3 className="text-xs font-medium">Files &amp; folders</h3>
            <div className="divide-y rounded-lg border">
              {[['/sandbox', 'Workspace'], ['/tmp', 'Temporary files']].map(([path, label]) => {
                const inherited = t.filesystem.readWrite.find(parent => parent !== path && (parent === '/' || path.startsWith(`${parent.replace(/\/$/, '')}/`)))
                const inheritedRead = t.filesystem.readOnly.find(parent => parent !== path && (parent === '/' || path.startsWith(`${parent.replace(/\/$/, '')}/`)))
                return <div key={path} className="space-y-1 px-3 py-2">
                  <div className="flex flex-wrap items-center justify-between gap-2"><Label htmlFor={`folder-${path.slice(1)}`} className="text-xs">{label} <span className="ml-1 font-mono text-[10px] text-muted-foreground">{path}</span></Label>
                    <SelectField id={`folder-${path.slice(1)}`} aria-label={`${label} access`} value={folderAccess(t.filesystem, path)} disabled={Boolean(inherited)} onChange={event => update({ filesystem: setFolderAccess(t.filesystem, path, event.target.value) })} className={selectClass}>
                      <option value="none" disabled={Boolean(inheritedRead)}>No access</option><option value="readOnly">Read only</option><option value="readWrite">Read &amp; write</option>
                    </SelectField>
                  </div>
                  {!inherited && inheritedRead && <p className="text-[11px] text-muted-foreground">Read access is included through {inheritedRead}.</p>}
                  {inherited && <p className="text-[11px] text-muted-foreground">Writable through {inherited}. Change that parent folder to restrict access.</p>}
                  {path === '/sandbox' && folderAccess(t.filesystem, path) !== 'readWrite' && <p className="text-[11px] text-muted-foreground">Some agents need workspace writes to operate. More specific folder permissions still apply.</p>}
                </div>
              })}
            </div>
            <FolderList filesystem={t.filesystem} onChange={filesystem => update({ filesystem })} />
            <p className="text-[11px] text-muted-foreground">Permissions apply to paths inside the sandbox and their contents. Adding a path does not mount a folder from your computer.</p>
            <Disclosure title="System folders & protection settings">
              <p className="text-[11px] text-muted-foreground">These paths support the sandbox runtime. Parent folder permissions also apply to their contents.</p>
              <FolderList filesystem={t.filesystem} system onChange={filesystem => update({ filesystem })} />
              <div className="grid gap-1.5"><Label htmlFor="filesystem-enforcement" className="text-xs">If filesystem protection cannot be applied</Label><SelectField id="filesystem-enforcement" value={t.landlock} onChange={event => update({ landlock: event.target.value })} className={selectClass}><option value="best_effort">Continue with available protection</option><option value="hard_requirement">Stop sandbox startup</option></SelectField>
                <p className="text-[11px] text-muted-foreground">{t.landlock === 'hard_requirement' ? 'Requires Landlock filesystem enforcement. Startup fails if the required protection cannot be enforced.' : 'Best effort: some or all configured filesystem restrictions may be unavailable. Failures are logged.'}</p>
              </div>
              {t.ingress?.length > 0 && <p className="text-[11px] text-muted-foreground">Preserves {t.ingress.length} existing startup services. Manage services from the sandbox’s Services controls.</p>}
            </Disclosure>
          </section>}
          {(error || compositionError) && <p role="alert" className="text-xs text-destructive">{error || compositionError}</p>}
        </fieldset>
      </div>
      <div className="shrink-0 space-y-3 border-t bg-muted/30 px-5 py-3">
        {initial.idLocked && <p className="text-[11px] text-muted-foreground">Changes apply to future launches. Existing sandboxes keep their current rules.</p>}
        <div className="flex items-center justify-end gap-2">{initial.idLocked && <Button variant="ghost" className="mr-auto text-destructive" disabled={busy} onClick={() => onDelete(initial)}><Trash2 />Delete</Button>}<Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button><Button onClick={save} disabled={busy || !t.name.trim() || Boolean(compositionError)} className="bg-[var(--action)] text-[var(--action-foreground)] hover:bg-[var(--action)]/90">{busy && <Spinner />}{initial.idLocked ? 'Save changes' : 'Create policy'}</Button></div>
      </div>
      <DestinationDialog open={adding} onClose={() => setAdding(false)} onAdd={addRule} rules={t.rules} onAdvanced={spec => setRule({ index: -1, spec })} />
      <RuleEditor open={Boolean(rule)} onOpenChange={value => { if (!value) setRule(null) }} initial={rule?.spec} knownPrograms={knownPrograms} title={rule?.index >= 0 ? 'Edit destination rule' : 'Advanced destination settings'} submitLabel={rule?.index >= 0 ? 'Save destination' : 'Add destination'} onSubmit={addRule} />
    </DialogContent>
  </Dialog>
}
