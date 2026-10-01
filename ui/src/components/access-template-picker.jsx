import { BUILTIN_TEMPLATES, normalizeAccessTemplates, toggleAccessTemplate } from '../../shared/policy-templates.js'

export function AccessTemplatePicker({ value = [], inherited = [], onChange, disabled = false, templates = BUILTIN_TEMPLATES }) {
  const selected = normalizeAccessTemplates([...inherited, ...value], templates)
  return <fieldset className="grid gap-1.5" disabled={disabled}>
    <legend className="mb-1.5 text-xs font-medium">Additional access</legend>
    <div className="divide-y rounded-md border">
      {templates.filter((template) => template.kind === 'access').map((template) => <div key={template.id} className="px-3 py-2">
        <label className="flex cursor-pointer items-center gap-2 text-xs">
          <input type="checkbox" className="size-3.5 accent-primary" checked={selected.includes(template.id)}
            disabled={disabled || inherited.includes(template.id) || (template.id === 'github-read' && inherited.includes('github-write'))}
            onChange={() => onChange(toggleAccessTemplate(value, template.id, templates))} />
          {template.name}
          {inherited.includes(template.id) && <span className="ml-auto text-[10px] text-muted-foreground">Included in policy</span>}
        </label>
        <details className="ml-5 mt-1 text-[11px] text-muted-foreground">
          <summary className="w-fit cursor-pointer">Access details</summary>
          <p className="mt-1">{template.description}</p>
          <p className="mt-1 break-words font-mono text-[10px]">{template.rules.flatMap((rule) => rule.endpoints.map((endpoint) => endpoint.host)).join(', ')}</p>
          <p className="mt-1">Allowed programs</p>
          <ul className="mt-1 break-all font-mono text-[10px]">{template.rules.flatMap((rule) => rule.binaries).map((binary) => <li key={binary}>{binary}</li>)}</ul>
        </details>
      </div>)}
    </div>
    <p className="text-[11px] text-muted-foreground">Adds to agent connections, attached secrets, and shared rules. Organization blocks still apply.</p>
  </fieldset>
}
