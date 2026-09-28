import * as React from "react"
import { AlertTriangle } from "lucide-react"
import { toast } from "sonner"

import { Spinner } from "@/components/ui/spinner"
import { api } from "@/lib/api"
import { useLive } from "@/lib/live"

// The gateway's registered settings that change how policy is enforced,
// described by what they do to a sandbox rather than by their keys.
const GUARDRAILS = [
  {
    key: "proposal_approval_mode", type: "choice",
    title: "Approving blocked requests",
    options: [{ id: "manual", label: "Always ask me" }, { id: "auto", label: "Auto-approve safe ones" }],
    describe: "Auto-approve applies drafts the prover finds clean. GraphQL and MCP are not checked.",
    risk: (v) => v === "auto" && "Rules can be added without your review.",
    fallback: "manual",
  },
  {
    key: "agent_policy_proposals_enabled", type: "bool",
    title: "Agents can ask for access",
    describe: "Agents can submit their own policy proposals to Approvals.",
    fallback: false,
  },
  {
    key: "ocsf_json_enabled", type: "bool",
    title: "OCSF JSON audit log",
    describe: "Writes security events to /var/log/openshell-ocsf*.log for a SIEM.",
    fallback: false,
  },
]

function Control({ spec, value, onChange, disabled, busy, compact }) {
  const current = value ?? spec.fallback
  const options = spec.type === "bool" ? [{ id: false, label: "Off" }, { id: true, label: "On" }] : spec.options
  return (
    <div className="flex items-center gap-1.5">
      <div role="radiogroup" aria-label={spec.title} className={`flex items-center gap-1 rounded-md border border-border p-0.5 ${disabled ? "opacity-50" : ""}`}>
        {options.map((o) => (
          <button key={String(o.id)} role="radio" aria-checked={current === o.id} disabled={disabled || busy} onClick={() => current !== o.id && onChange(o.id)}
            className={`rounded px-2.5 py-1 text-[11px] whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed ${current === o.id ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
            {compact && spec.type === "choice" ? (o.id === "auto" ? "Auto" : "Ask") : o.label}
          </button>
        ))}
      </div>
      {busy && <Spinner className="size-3" />}
    </div>
  )
}

export function GuardrailsView() {
  const live = useLive()
  const sandboxes = (live.sandboxes ?? []).filter((s) => s.phase !== "deleting")
  const [global, setGlobal] = React.useState(null)
  const [perSandbox, setPerSandbox] = React.useState({})
  const [busy, setBusy] = React.useState(null)

  const load = React.useCallback(async () => {
    try {
      const g = await api.settings()
      setGlobal(g.global)
      const entries = await Promise.all(sandboxes.map(async (s) => [s.name, (await api.settings(s.name).catch(() => ({ sandbox: null }))).sandbox]))
      setPerSandbox(Object.fromEntries(entries))
    } catch (e) { toast.error(e.message) }
  }, [sandboxes.map((s) => s.name).join(",")]) // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => { load() }, [load])

  async function set(scope, key, value, clear = false) {
    setBusy(`${scope}:${key}`)
    try {
      await api.setSetting({ sandbox: scope === "global" ? null : scope, key, value, clear })
      toast.success(clear ? "Reset to the gateway default" : scope === "global" ? "Applied to every sandbox" : `Applied to ${scope}`)
      await load()
    } catch (e) { toast.error(e.message) } finally { setBusy(null) }
  }

  if (!global) return <p role="status" className="py-16 text-center text-sm text-muted-foreground">Loading…</p>

  return (
    <div className="h-[calc(100svh-3.5rem)] overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-4 px-4 py-6 sm:px-6">
        {GUARDRAILS.map((spec) => {
          const g = global[spec.key]
          const warning = spec.risk?.(g)
          return (
            <section key={spec.key} className="rounded-lg border border-border bg-card">
              <div className="grid gap-3 border-b border-border/70 px-5 py-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-start">
                <div>
                  <h2 className="w-fit text-[13px] font-medium" title={`${spec.describe}\n${spec.key}`}>{spec.title}</h2>
                </div>
                <div className="space-y-1.5 md:text-right">
                  <p className="text-[10px] font-bold tracking-widest text-faint uppercase">Gateway-wide</p>
                  <div className="flex items-center gap-2 md:justify-end">
                    <Control spec={spec} value={g} busy={busy === `global:${spec.key}`} onChange={(v) => set("global", spec.key, v)} />
                  </div>
                  {g !== null && g !== undefined
                    ? <button onClick={() => set("global", spec.key, null, true)} title="Let each sandbox choose" className="text-[10px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">Clear</button>
                    : <p className="text-[10px] text-muted-foreground">Default: {String(spec.type === "choice" ? spec.options.find((o) => o.id === spec.fallback).label.toLowerCase() : spec.fallback ? "on" : "off")}</p>}
                </div>
              </div>
              {warning && <p className="flex items-center gap-1.5 border-b border-border/70 bg-amber-50/60 px-5 py-2 text-[11px] text-amber-800"><AlertTriangle className="size-3.5" />{warning}</p>}
              <div>
                {sandboxes.map((s) => {
                  const entry = perSandbox[s.name]?.[spec.key]
                  const overridden = entry?.scope === "global"
                  return (
                    <div key={s.id} className="flex h-[40px] items-center gap-3 border-b border-border/50 px-5 last:border-0">
                      <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{s.name}</span>
                      <span className="hidden text-[10px] text-muted-foreground sm:block">{overridden ? "gateway-wide" : entry?.scope === "sandbox" ? "custom" : "default"}</span>
                      <Control compact spec={spec} value={entry?.value} disabled={overridden} busy={busy === `${s.name}:${spec.key}`} onChange={(v) => set(s.name, spec.key, v)} />
                      {entry?.scope === "sandbox" && !overridden && (
                        <button onClick={() => set(s.name, spec.key, null, true)} className="text-[10px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">Reset</button>
                      )}
                    </div>
                  )
                })}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}
