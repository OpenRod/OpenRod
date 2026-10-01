import * as React from "react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { ArrowLeft, ArrowUpRight, Check, Lock, Search } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { ServiceLogo } from "@/components/service-logo"
import { credentialFields, setupIssue, validateSecretCredentials } from "../../shared/secret-fields"
import { useApi } from "@/lib/location-context"
import { SERVICES, SERVICE_GROUPS } from "@/lib/services"

// Step one is a choice of service, not of "profile": the profile behind it is
// imported the moment it's picked, and the person never has to know it exists.
function ServiceGrid({ query, setQuery, have, onPick, picking }) {
  const q = query.trim().toLowerCase()
  const match = (s) => !q || `${s.name} ${s.blurb} ${s.id}`.toLowerCase().includes(q)
  const groups = SERVICE_GROUPS.map((g) => ({ ...g, items: SERVICES.filter((s) => s.group === g.id && match(s)) })).filter((g) => g.items.length)
  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="absolute top-2.5 left-3 size-3.5 text-muted-foreground" aria-hidden="true" />
        <Input value={query} onChange={(e) => setQuery(e.target.value)} className="h-9 pl-9 text-xs" placeholder="Search services" aria-label="Search services" autoFocus />
      </div>
      <div className="-mx-1 max-h-[60svh] space-y-3 overflow-y-auto px-1 pt-1">
        {groups.map((g) => (
          <section key={g.id}>
            <h3 className="mb-1.5 text-[10px] font-bold tracking-widest text-faint uppercase">{g.label}</h3>
            <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4">
              {g.items.map((s) => (
                <button key={s.id} type="button" onClick={() => onPick(s)} disabled={Boolean(picking)} title={s.blurb}
                  className="group relative flex items-center gap-2 rounded-lg border border-border/70 bg-card py-1.5 pr-2 pl-1.5 text-left outline-none transition-[border-color,background-color,transform] hover:border-foreground/20 hover:bg-muted/30 focus-visible:ring-2 focus-visible:ring-ring motion-safe:hover:-translate-y-px disabled:opacity-60">
                  {picking === s.id ? <span className="flex size-6 items-center justify-center"><Spinner className="size-3.5" /></span> : <ServiceLogo type={s.id} size="sm" />}
                  <span className="min-w-0 truncate text-[12px] font-medium">{s.name}</span>
                  {have.has(s.id) && (
                    <span className="absolute -top-1 -right-1 flex size-3.5 items-center justify-center rounded-full bg-emerald-500 text-white" title="You already have a secret for this">
                      <Check className="size-2.5" strokeWidth={3} />
                    </span>
                  )}
                </button>
              ))}
            </div>
          </section>
        ))}
        {!groups.length && <p className="py-6 text-center text-[11px] text-muted-foreground">No service matches “{query}”.</p>}
      </div>
    </div>
  )
}

function KeyForm({ service, profile, taken, sandboxes, onBack, onDone }) {
  const api = useApi()
  const [name, setName] = React.useState(() => {
    const base = `my-${service.id}`
    if (!taken.has(base)) return base
    for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`
  })
  const [values, setValues] = React.useState({})
  const [attach, setAttach] = React.useState([])
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState(null)
  const hosts = profile.endpoints.map((e) => e.host)
  const creds = credentialFields(profile)
  const issue = setupIssue(profile)
  const oauth = profile.id === "codex" && creds.some((c) => c.key === "CODEX_AUTH_ACCESS_TOKEN")
  // Some profiles grant network access and carry no credential (PyPI). Say so
  // instead of showing an empty form.
  const keyless = creds.length === 0

  async function submit(event) {
    event.preventDefault()
    setBusy(true); setError(null)
    try {
      await api.createSecret({ name, type: profile.id, credentials: validateSecretCredentials(profile, values) })
      setValues({})
      const failed = []
      for (const sandbox of attach) { try { await api.attachSecret(name, sandbox, true) } catch { failed.push(sandbox) } }
      toast.success(`Stored ${name}`, { description: attach.length ? `Attached to ${attach.filter((s) => !failed.includes(s)).join(", ") || "none"}${failed.length ? ` · failed: ${failed.join(", ")}` : ""}` : "Credential saved. Vendor connection not tested." })
      onDone()
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  return (
    <form onSubmit={submit} autoComplete="off" className="space-y-4">
      <div className="flex items-center gap-3">
        <Button type="button" variant="ghost" size="icon-sm" onClick={onBack} aria-label="Choose another service"><ArrowLeft /></Button>
        <ServiceLogo type={service.id} size="lg" />
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-medium">{service.name}</p>
          <p className="truncate text-[11px] text-muted-foreground">{service.blurb}</p>
        </div>
        {service.keyUrl && !keyless && !issue && (
          <a href={service.keyUrl} target="_blank" rel="noreferrer"
            className="flex shrink-0 items-center gap-0.5 rounded-md px-2 py-1 text-[11px] text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
            Get a key<ArrowUpRight className="size-3" />
          </a>
        )}
      </div>

      {oauth && <p className="rounded-lg border border-border bg-muted/30 px-3 py-2.5 text-xs leading-relaxed">This profile stores an existing ChatGPT OAuth session: access token, refresh token, and account ID, with an optional ID token. An OpenAI API key does not belong in these fields. Browser sign-in and API-key setup for Codex are not available in this form. <a className="underline" href={service.helpUrl} target="_blank" rel="noreferrer">Authentication guide</a></p>}
      {issue && <p role="status" className="rounded-lg border border-border bg-muted/30 px-3 py-2.5 text-xs leading-relaxed">{issue}</p>}
      {keyless && (
        <p className="rounded-lg border border-border px-3 py-2.5 text-[11px] leading-relaxed">
          <span className="font-medium">No key needed.</span>{" "}
          <span className="text-muted-foreground">This lets a sandbox reach {service.name}'s hosts, but only from the programs below.</span>
        </p>
      )}
      <div className="space-y-2.5">
        {!issue && creds.map((c, i) => {
          const key = c.key
          return (
            <label key={key} className="block">
              <span className="mb-1 flex items-baseline gap-2 text-[11px]">
                <span className="font-medium">{c.label}{c.required ? <span className="text-muted-foreground"> · required</span> : <span className="font-normal text-muted-foreground"> · optional</span>}</span>
                <span className="font-mono text-[10px] text-muted-foreground">{key}</span>
              </span>
              <span className="relative block">
                <Lock className="absolute top-2.5 left-3 size-3.5 text-muted-foreground" aria-hidden="true" />
                <Input aria-label={c.label} type={c.inputType} value={values[key] ?? ""} onChange={(e) => setValues((cur) => ({ ...cur, [key]: e.target.value }))}
                  className="h-9 pl-9 font-mono text-xs" placeholder={creds.length === 1 && service.keyHint ? service.keyHint : c.placeholder}
                  required={c.required} maxLength={8192} autoFocus={i === 0} spellCheck={false} autoComplete="off" />
              </span>
            </label>
          )
        })}
      </div>

      {/* The whole security story of this secret, in one glance. */}
      <div className="rounded-lg border border-border bg-muted/30 px-3 py-2.5">
        <p className="text-[10px] font-bold tracking-widest text-faint uppercase">{"Profile destinations"}</p>
        <div className="mt-1.5 flex flex-wrap gap-1">
          {hosts.map((h) => <span key={h} className="rounded border border-border bg-card px-1.5 py-0.5 font-mono text-[10px]">{h}</span>)}
        </div>
        <p className="mt-1.5 text-[10px] text-muted-foreground">
          Allowed program paths: {profile.binaries.join(", ") || "None declared"}. These must match the programs installed in your sandbox.
        </p>
      </div>

      {!issue && <div className="flex flex-wrap items-end gap-3">
        <label className="grid w-44 gap-1">
          <span className="text-[11px] text-muted-foreground">Name</span>
          <Input value={name} onChange={(e) => setName(e.target.value.toLowerCase())} className="h-8 font-mono text-xs" required pattern="[a-z0-9]([a-z0-9\-]{0,61}[a-z0-9])?" />
        </label>
        {sandboxes.length > 0 && (
          <div className="min-w-0 flex-1">
            <span className="mb-1 block text-[11px] text-muted-foreground">Attach to</span>
            <div className="flex flex-wrap gap-1">
              {sandboxes.map((s) => {
                const on = attach.includes(s.name)
                return (
                  <button key={s.id} type="button" aria-pressed={on} onClick={() => setAttach((a) => (on ? a.filter((x) => x !== s.name) : [...a, s.name]))}
                    className={`flex h-8 items-center gap-1.5 rounded-md border px-2 font-mono text-[11px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${on ? "border-foreground/25 bg-accent" : "border-border text-muted-foreground hover:text-foreground"}`}>
                    <span className={`size-1.5 rounded-full ${on ? "bg-emerald-500" : "bg-stone-300"}`} aria-hidden="true" />{s.name}
                  </button>
                )
              })}
            </div>
          </div>
        )}
      </div>

      }
      {error && <p role="alert" className="rounded-md border border-red-200 bg-red-50/60 px-3 py-2 text-[11px] text-red-700">{error}</p>}
      <Button type="submit" disabled={busy || Boolean(issue)} className="h-9 w-full bg-[var(--action)] text-[var(--action-foreground)] hover:bg-[var(--action)]/90">
        {busy ? <Spinner /> : <Lock />}{keyless ? `Add ${service.name} access` : `Store ${service.name} secret`}
      </Button>
    </form>
  )
}

export function AddSecretDialog({ open, onOpenChange, profiles, providers, sandboxes, reload }) {
  const api = useApi()
  const reduce = useReducedMotion()
  const [query, setQuery] = React.useState("")
  const [service, setService] = React.useState(null)
  const [picking, setPicking] = React.useState(null)
  const [known, setKnown] = React.useState(profiles)
  React.useEffect(() => setKnown(profiles), [profiles])
  React.useEffect(() => { if (!open) { setService(null); setQuery(""); setPicking(null) } }, [open])

  const have = new Set(providers.map((p) => p.type))
  const taken = new Set(providers.map((p) => p.name))
  const profile = service && known.find((p) => p.id === service.id)

  async function pick(s) {
    if (known.some((p) => p.id === s.id)) { setService(s); return }
    setPicking(s.id)
    try {
      await api.importProfile(s.id)
      const fresh = await reload()
      setKnown(fresh?.profiles ?? known)
      setService(s)
    } catch (e) { toast.error(`Couldn't set up ${s.name}: ${e.message}`) } finally { setPicking(null) }
  }

  const step = service && profile ? "key" : "pick"
  const slide = reduce ? {} : { initial: { opacity: 0, x: step === "key" ? 12 : -12 }, animate: { opacity: 1, x: 0 }, exit: { opacity: 0, x: step === "key" ? -12 : 12 }, transition: { duration: 0.16, ease: "easeOut" } }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-[580px]" aria-describedby={undefined}>
        <div className="border-b border-border px-5 pt-4 pb-3">
          <DialogTitle className="text-[14px]">{step === "pick" ? "Add secret" : profile?.credentials.length === 0 ? `Add ${service.name}` : "Add credentials"}</DialogTitle>
          <p className="mt-0.5 text-[11px] text-muted-foreground">{step === "pick" ? "Pick the service it's for." : profile?.credentials.length === 0 ? "Access only. Nothing secret is stored." : "Stored by the gateway. Saving does not verify the vendor connection."}</p>
        </div>
        <div className="max-h-[75svh] overflow-y-auto p-5">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={step} {...slide}>
              {step === "pick"
                ? <ServiceGrid query={query} setQuery={setQuery} have={have} onPick={pick} picking={picking} />
                : <KeyForm service={service} profile={profile} taken={taken} sandboxes={sandboxes} onBack={() => setService(null)} onDone={() => { onOpenChange(false); reload() }} />}
            </motion.div>
          </AnimatePresence>
        </div>
      </DialogContent>
    </Dialog>
  )
}
