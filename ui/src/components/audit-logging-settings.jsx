import * as React from "react"
import { AlertTriangle } from "lucide-react"
import { toast } from "sonner"

import { Spinner } from "@/components/ui/spinner"
import { useApi } from "@/lib/compute"
import { useLive } from "@/lib/live"

// The gateway's registered settings that change how policy is enforced,
// described by what they do to a sandbox rather than by their keys.
const LOG_SETTINGS = [
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

export function AuditLoggingSettings() {
  const api = useApi()
  const live = useLive()
  const sandboxes = (live.sandboxes ?? []).filter((s) => s.phase !== "deleting")
  const [global, setGlobal] = React.useState(null)
  const [perSandbox, setPerSandbox] = React.useState({})
  const [busy, setBusy] = React.useState(null)
  const [error, setError] = React.useState(null)

  const load = React.useCallback(async () => {
    setError(null)
    try {
      const g = await api.settings()
      setGlobal(g.global)
      const entries = await Promise.all(sandboxes.map(async (s) => [s.name, (await api.settings(s.name).catch(() => ({ sandbox: null }))).sandbox]))
      setPerSandbox(Object.fromEntries(entries))
    } catch (e) { setError(e.message) }
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

  if (error) return <div role="alert" className="p-5 text-sm"><p>{error}</p><button onClick={load} className="mt-2 underline">Try again</button></div>
  if (!global) return <p role="status" className="py-16 text-center text-sm text-muted-foreground">Loading…</p>

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="space-y-4 p-5">
        <p className="text-xs leading-relaxed text-muted-foreground">Write OCSF JSON files for external security monitoring. Activity collects events separately; this setting does not control the Activity feed. Use Activity webhooks to forward collected events directly. Retention of these separate log files is configured outside the console.</p>
        {LOG_SETTINGS.map((spec) => {
          const g = global[spec.key]
          const warning = spec.risk?.(g)
          return (
            <section key={spec.key} className="rounded-lg border border-border bg-card">
              <div className="grid gap-3 border-b border-border/70 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
                <div>
                  <h2 className="w-fit text-[13px] font-medium" title={`${spec.describe}\n${spec.key}`}>{spec.title}</h2>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{spec.describe}</p>
                </div>
                <div className="space-y-1.5 sm:text-right">
                  <p className="text-[10px] font-bold tracking-widest text-faint uppercase">Gateway-wide</p>
                  <div className="flex items-center gap-2 sm:justify-end">
                    <Control spec={spec} value={g} busy={busy === `global:${spec.key}`} onChange={(v) => set("global", spec.key, v)} />
                  </div>
                  {g !== null && g !== undefined
                    ? <button onClick={() => set("global", spec.key, null, true)} title="Let each sandbox choose" className="text-[10px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">Use per-sandbox settings</button>
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
