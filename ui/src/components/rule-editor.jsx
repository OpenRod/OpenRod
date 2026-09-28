import * as React from "react"
import { AlertTriangle, Plus, Trash2, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Spinner } from "@/components/ui/spinner"

export const PROTOCOLS = [
  { id: "rest", label: "HTTP", hint: "Inspect each request: method and path" },
  { id: "tcp", label: "TCP", hint: "Connection only; nothing inside is inspected" },
  { id: "websocket", label: "WebSocket" },
  { id: "graphql", label: "GraphQL" },
]
const ACCESS = [
  { id: "read-only", label: "Read only", hint: "GET, HEAD and OPTIONS" },
  { id: "read-write", label: "Read & write", hint: "Adds POST, PUT, PATCH and DELETE" },
  { id: "full", label: "Full", hint: "Any request" },
  { id: "custom", label: "Specific requests", hint: "Only the method and path pairs listed" },
]
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "*"]

const endpoint = (over = {}) => ({ host: "", ports: "443", protocol: "rest", access: "read-only", allow: [], deny: [], enforcement: "enforce", allowedIps: "", ...over })

// Common destinations, expressed as the narrowest rule that does the job.
export const RULE_PRESETS = [
  { id: "github-api-read", label: "GitHub API · read", rule: { name: "github-api-read", binaries: [], endpoints: [endpoint({ host: "api.github.com", access: "custom", allow: [{ method: "GET", path: "/repos/**" }] })] } },
  { id: "github-git", label: "git clone from GitHub", rule: { name: "github-git", binaries: ["/usr/lib/git-core/git-remote-http", "/usr/lib/git-core/git-remote-https"], endpoints: [endpoint({ host: "github.com" }), endpoint({ host: "codeload.github.com" })] } },
  { id: "npm", label: "npm registry", rule: { name: "npm-registry", binaries: ["/usr/bin/node", "/usr/local/bin/node"], endpoints: [endpoint({ host: "registry.npmjs.org" })] } },
  { id: "pypi", label: "PyPI", rule: { name: "pypi", binaries: ["/usr/bin/python3*", "/usr/local/bin/pip*"], endpoints: [endpoint({ host: "pypi.org" }), endpoint({ host: "files.pythonhosted.org" })] } },
  { id: "huggingface", label: "Hugging Face · downloads", rule: { name: "huggingface", binaries: ["/usr/bin/python3*"], endpoints: [endpoint({ host: "huggingface.co" }), endpoint({ host: "**.hf.co" })] } },
]

// Editor state ↔ the rule spec the server validates.
export function specToForm(spec) {
  return {
    name: spec?.name ?? "",
    binaries: [...(spec?.binaries ?? [])],
    endpoints: (spec?.endpoints?.length ? spec.endpoints : [endpoint()]).map((e) => endpoint({
      ...e,
      ports: Array.isArray(e.ports) ? e.ports.join(", ") : String(e.ports ?? e.port ?? "443"),
      access: e.allow?.length ? "custom" : e.access && e.access !== "custom" ? e.access : "read-only",
      protocol: e.protocol ?? "rest",
      allowedIps: Array.isArray(e.allowedIps) ? e.allowedIps.join(", ") : e.allowedIps ?? "",
      allow: [...(e.allow ?? [])], deny: [...(e.deny ?? [])],
    })),
  }
}

export function formToSpec(form) {
  return {
    name: form.name.trim(),
    binaries: form.binaries,
    endpoints: form.endpoints.map((e) => ({
      host: e.host.trim(),
      ports: e.ports.split(/[\s,]+/).filter(Boolean).map(Number),
      protocol: e.protocol,
      access: e.protocol === "tcp" || e.access === "custom" ? null : e.access,
      allow: e.protocol === "tcp" || e.access !== "custom" ? [] : e.allow.filter((r) => r.path),
      deny: e.protocol === "tcp" ? [] : e.deny.filter((r) => r.path),
      enforcement: e.enforcement,
      allowedIps: e.allowedIps.split(/[\s,]+/).filter(Boolean),
    })),
  }
}

// A rule at a glance: its name and where it reaches. The full sentence is on hover.
export function RuleLine({ rule, className = "" }) {
  const hosts = [...new Set((rule.endpoints ?? []).map((e) => e.host).filter(Boolean))]
  return (
    <span className={`flex min-w-0 flex-wrap items-center gap-1.5 ${className}`} title={describeRule(rule)}>
      <span className="font-mono font-medium">{rule.name}</span>
      {hosts.map((h) => <span key={h} className="rounded border border-border px-1.5 py-px font-mono text-[10px] text-muted-foreground">{h}</span>)}
    </span>
  )
}

// The rule in one sentence, so the operator reads what it grants rather than
// reconstructing it from form fields.
export function describeRule(input) {
  // Saved templates may omit empty lists; read them as empty rather than trusting the shape.
  const spec = { binaries: input.binaries ?? [], endpoints: (input.endpoints ?? []).map((e) => ({ ...e, ports: e.ports ?? (e.port ? [e.port] : []), allow: e.allow ?? [], deny: e.deny ?? [] })) }
  const who = spec.binaries.length ? [...new Set(spec.binaries.map((b) => b.split("/").pop()))].join(", ") : "no program"
  const parts = spec.endpoints.map((e) => {
    const where = `${e.host || "…"}:${e.ports.join(",") || "…"}`
    if (e.protocol === "tcp") return `open connections to ${where}`
    if (e.allow.length) return `send ${e.allow.map((r) => `${r.method} ${r.path}`).join(", ")} to ${where}`
    return `make ${ACCESS.find((a) => a.id === e.access)?.label.toLowerCase() ?? ""} requests to ${where}`
  })
  const denies = spec.endpoints.flatMap((e) => e.deny.map((r) => `${r.method} ${r.path}`))
  const audit = spec.endpoints.some((e) => e.enforcement === "audit")
  return `${who} may ${parts.join("; and ")}${denies.length ? `, except ${denies.join(", ")}` : ""}.${audit ? " Audit only: violations are logged but allowed." : ""}`
}

function Segmented({ options, value, onChange, label }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex items-center gap-1 rounded-md border border-border p-0.5">
      {options.map((o) => (
        <button key={o.id} type="button" role="radio" aria-checked={value === o.id} onClick={() => onChange(o.id)} title={o.hint}
          className={`flex-1 rounded px-2 py-1 text-[11px] whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${value === o.id ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

function RequestList({ items, onChange, kind }) {
  return (
    <div className="space-y-1.5">
      {items.map((r, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <select value={r.method} onChange={(e) => onChange(items.map((x, j) => (j === i ? { ...x, method: e.target.value } : x)))}
            aria-label="Method" className="h-8 rounded-md border border-input bg-transparent px-1.5 font-mono text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {METHODS.map((m) => <option key={m}>{m}</option>)}
          </select>
          <Input value={r.path} onChange={(e) => onChange(items.map((x, j) => (j === i ? { ...x, path: e.target.value } : x)))}
            className="h-8 font-mono text-[11px]" placeholder="/repos/**" aria-label="Path pattern" />
          <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove ${kind} rule`} onClick={() => onChange(items.filter((_, j) => j !== i))}><X className="size-3.5" /></Button>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...items, { method: "GET", path: "" }])}
        className={`flex items-center gap-1 text-[11px] outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring ${kind === "deny" ? "text-red-700" : "text-muted-foreground"}`}>
        <Plus className="size-3" />{kind === "deny" ? "Block request" : "Allow request"}
      </button>
    </div>
  )
}

export function RuleEditor({ open, onOpenChange, initial, onSubmit, knownPrograms = [], title = "New rule", submitLabel = "Add rule", lockName = false }) {
  const [form, setForm] = React.useState(() => specToForm(initial))
  const [program, setProgram] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState(null)
  React.useEffect(() => { if (open) { setForm(specToForm(initial)); setError(null); setProgram("") } }, [open, initial])

  const setEndpoint = (i, patch) => setForm((f) => ({ ...f, endpoints: f.endpoints.map((e, j) => (j === i ? { ...e, ...patch } : e)) }))
  const addProgram = (path) => {
    const value = path.trim()
    if (value && !form.binaries.includes(value)) setForm((f) => ({ ...f, binaries: [...f.binaries, value] }))
    setProgram("")
  }
  const spec = formToSpec(form)
  const suggestions = knownPrograms.filter((p) => !form.binaries.includes(p))

  async function submit(event) {
    event.preventDefault()
    setBusy(true); setError(null)
    try { await onSubmit(spec); onOpenChange(false) } catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-xl">
        <form onSubmit={submit} className="grid gap-5">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription className="sr-only">Everything not allowed by a rule stays denied.</DialogDescription>
          </DialogHeader>

          {!lockName && (
            <div className="flex flex-wrap gap-1.5">
              <span className="self-center text-[11px] text-muted-foreground">Presets</span>
              {RULE_PRESETS.map((p) => (
                <button key={p.id} type="button" onClick={() => setForm(specToForm(p.rule))}
                  className="rounded border border-border px-2 py-0.5 text-[11px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                  {p.label}
                </button>
              ))}
            </div>
          )}

          <div className="grid gap-1.5">
            <Label htmlFor="rule-name" className="text-xs">Rule name</Label>
            <Input id="rule-name" value={form.name} disabled={lockName} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value.toLowerCase() }))}
              className="font-mono text-xs" placeholder="github-api-read" required />
          </div>

          <div className="grid gap-1.5">
            <span className="text-xs font-medium">Programs</span>
            <div className="flex flex-wrap gap-1.5">
              {form.binaries.map((b) => (
                <span key={b} className="flex items-center gap-1 rounded-md border border-foreground/20 bg-accent py-0.5 pr-0.5 pl-2 font-mono text-[11px]">
                  {b}
                  <button type="button" aria-label={`Remove ${b}`} onClick={() => setForm((f) => ({ ...f, binaries: f.binaries.filter((x) => x !== b) }))}
                    className="rounded p-0.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"><X className="size-3" /></button>
                </span>
              ))}
              {!form.binaries.length && <span className="text-[11px] text-amber-700">Add at least one program</span>}
            </div>
            <div className="flex gap-1.5">
              <Input value={program} onChange={(e) => setProgram(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addProgram(program) } }}
                className="h-8 font-mono text-[11px]" placeholder="/usr/bin/curl" title="Globs like /usr/bin/python3* work" aria-label="Program path" />
              <Button type="button" variant="outline" size="sm" onClick={() => addProgram(program)} disabled={!program.trim()}>Add</Button>
            </div>
            {suggestions.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[10px] text-muted-foreground">Seen</span>
                {suggestions.slice(0, 6).map((p) => (
                  <button key={p} type="button" onClick={() => addProgram(p)}
                    className="rounded border border-dashed border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                    + {p}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="grid gap-3">
            <span className="text-xs font-medium">Destinations</span>
            {form.endpoints.map((e, i) => (
              <div key={i} className="grid gap-3 rounded-lg border border-border p-3">
                <div className="flex items-end gap-2">
                  <div className="grid flex-1 gap-1">
                    <Label className="text-[11px] text-muted-foreground" htmlFor={`host-${i}`}>Host</Label>
                    <Input id={`host-${i}`} value={e.host} onChange={(ev) => setEndpoint(i, { host: ev.target.value })} className="h-8 font-mono text-[11px]" placeholder="api.github.com" title="Wildcards like *.example.com work" required />
                  </div>
                  <div className="grid w-24 gap-1">
                    <Label className="text-[11px] text-muted-foreground" htmlFor={`ports-${i}`}>Ports</Label>
                    <Input id={`ports-${i}`} value={e.ports} onChange={(ev) => setEndpoint(i, { ports: ev.target.value })} className="h-8 font-mono text-[11px]" placeholder="443" required />
                  </div>
                  {form.endpoints.length > 1 && (
                    <Button type="button" variant="ghost" size="icon-sm" aria-label="Remove destination" onClick={() => setForm((f) => ({ ...f, endpoints: f.endpoints.filter((_, j) => j !== i) }))}>
                      <Trash2 className="size-3.5" />
                    </Button>
                  )}
                </div>
                <Segmented label="Inspection" options={PROTOCOLS} value={e.protocol} onChange={(protocol) => setEndpoint(i, { protocol })} />
                {e.protocol !== "tcp" && (
                  <>
                    <Segmented label="Access" options={ACCESS} value={e.access} onChange={(access) => setEndpoint(i, { access, allow: access === "custom" && !e.allow.length ? [{ method: "GET", path: "" }] : e.allow })} />
                    {e.access === "custom" && <RequestList kind="allow" items={e.allow} onChange={(allow) => setEndpoint(i, { allow })} />}
                    <RequestList kind="deny" items={e.deny} onChange={(deny) => setEndpoint(i, { deny })} />
                  </>
                )}
                <div className="flex flex-wrap items-center gap-3">
                  <div className="w-52"><Segmented label="Enforcement" options={[{ id: "enforce", label: "Enforce" }, { id: "audit", label: "Audit only" }]} value={e.enforcement} onChange={(enforcement) => setEndpoint(i, { enforcement })} /></div>
                  {e.enforcement === "audit" && (
                    <span className="flex items-center gap-1 text-[11px] text-amber-700"><AlertTriangle className="size-3" />Logged, not blocked</span>
                  )}
                </div>
                <details className="group">
                  <summary title="Only for hosts resolving to private addresses. Loopback and metadata are always blocked." className="cursor-pointer text-[11px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">Private network access</summary>
                  <div className="mt-2 grid gap-1">
                    <Input value={e.allowedIps} onChange={(ev) => setEndpoint(i, { allowedIps: ev.target.value })} className="h-8 font-mono text-[11px]" placeholder="10.0.5.20/32" aria-label="Allowed IPs" />
                  </div>
                </details>
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" className="w-fit" onClick={() => setForm((f) => ({ ...f, endpoints: [...f.endpoints, endpoint()] }))}>
              <Plus />Add destination
            </Button>
          </div>

          <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-[11px] leading-relaxed">{describeRule(spec)}</p>
          {error && <p role="alert" className="rounded-md border border-red-200 bg-red-50/60 px-3 py-2 text-[11px] text-red-700">{error}</p>}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy || !form.binaries.length} className="bg-[var(--action)] text-[var(--action-foreground)] hover:bg-[var(--action)]/90">
              {busy && <Spinner aria-hidden="true" />}{submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
