import * as React from "react"
import { ShieldCheck } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Spinner } from "@/components/ui/spinner"
import { api } from "@/lib/api"
import { VmSetupPromptButton } from "@/components/vm-setup-prompt"

const EMPTY = { name: "", hostname: "", port: "", auth: "default", identityFile: "" }
const AUTH = [["default", "SSH agent / default keys"], ["identity", "Key file"]]

// Two steps: the details, then the host's key fingerprints. Nothing is saved
// until the user confirms they trust exactly the keys shown.
export function AddSshDialog({ open, onOpenChange, onAdded }) {
  const [form, setForm] = React.useState(EMPTY)
  const [scan, setScan] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState(null)
  const prefix = React.useId()

  React.useEffect(() => { if (open) { setForm(EMPTY); setScan(null); setError(null); setBusy(false) } }, [open])
  const set = (key) => (event) => { setForm((current) => ({ ...current, [key]: event.target.value })); setError(null) }
  const ready = form.name.trim() && form.hostname.trim() && (form.auth === "default" || form.identityFile.trim())

  async function run(operation) {
    setBusy(true); setError(null)
    try { await operation() } catch (reason) { setError(reason.message) } finally { setBusy(false) }
  }
  const check = (event) => { event.preventDefault(); if (ready && !busy) run(async () => setScan(await api.scanSshHost(form))) }
  const save = () => run(async () => { const saved = await api.addSshHost(scan.token); onAdded(saved) })

  return <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next) }}>
    <DialogContent className="sm:max-w-md" aria-describedby={undefined}>
      <DialogHeader><DialogTitle>{scan ? "Trust this machine?" : "Add SSH connection"}</DialogTitle></DialogHeader>
      {!scan ? <form autoComplete="off" className="grid gap-4 text-xs" onSubmit={check}>
        <div className="grid gap-1.5">
          <Label htmlFor={`${prefix}-name`} className="text-xs">Display name</Label>
          <Input id={`${prefix}-name`} value={form.name} onChange={set("name")} maxLength={60} placeholder="Build server" autoFocus />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${prefix}-host`} className="text-xs">Hostname</Label>
          <Input id={`${prefix}-host`} value={form.hostname} onChange={set("hostname")} spellCheck={false} autoCapitalize="none" placeholder="host.com or user@host.com" className="font-mono" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${prefix}-port`} className="text-xs">SSH port <span className="font-normal text-muted-foreground">(optional)</span></Label>
          <Input id={`${prefix}-port`} value={form.port} onChange={set("port")} inputMode="numeric" placeholder="22" className="font-mono" />
        </div>
        <div className="grid gap-2">
          <div role="radiogroup" aria-label="Authentication" className="inline-flex w-fit rounded-lg bg-muted p-0.5">
            {AUTH.map(([value, label]) => (
              <button key={value} type="button" role="radio" aria-checked={form.auth === value} onClick={() => { setForm((current) => ({ ...current, auth: value })); setError(null) }}
                className={`rounded-md px-3 py-1 transition-colors ${form.auth === value ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>{label}</button>
            ))}
          </div>
          {form.auth === "identity"
            ? <Input aria-label="Private key file" value={form.identityFile} onChange={set("identityFile")} spellCheck={false} autoCapitalize="none" placeholder="~/.ssh/id_ed25519" className="font-mono" />
            : <p className="text-muted-foreground">Uses your SSH agent and the keys SSH tries by default. Password logins aren’t supported.</p>}
        </div>
        {error && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 break-words whitespace-pre-wrap text-destructive">{error}</p>}
        <DialogFooter>
          <VmSetupPromptButton className="sm:mr-auto" />
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" disabled={!ready || busy} className="bg-[var(--action)] text-[var(--action-foreground)] hover:bg-[var(--action)]/90">{busy && <Spinner aria-hidden="true" />}{busy ? "Checking…" : "Continue"}</Button>
        </DialogFooter>
      </form> : <div className="grid gap-4 text-xs">
        <p className="text-muted-foreground">
          OpenRod reached <span className="font-mono text-foreground">{scan.user ? `${scan.user}@` : ""}{scan.host}{scan.port ? `:${scan.port}` : ""}</span> and it
          presented these host keys. Confirm they match the server before you trust it; a mismatch could mean someone is intercepting the connection.
        </p>
        <ul className="grid gap-2">
          {scan.fingerprints.map((item) => <li key={item.type} className="rounded-lg border border-border bg-muted/20 px-3 py-2">
            <span className="block text-[10px] text-muted-foreground">{item.type}</span>
            <span className="block font-mono break-all text-foreground">{item.fingerprint}</span>
          </li>)}
        </ul>
        <p className="text-muted-foreground">On the server, <code className="rounded bg-muted px-1 font-mono text-foreground">ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code> prints the matching fingerprint.</p>
        {error && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 break-words whitespace-pre-wrap text-destructive">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => { setScan(null); setError(null) }}>Back</Button>
          <Button type="button" disabled={busy} onClick={save} className="bg-[var(--action)] text-[var(--action-foreground)] hover:bg-[var(--action)]/90">{busy ? <Spinner aria-hidden="true" /> : <ShieldCheck aria-hidden="true" className="size-4" />}Trust and save</Button>
        </DialogFooter>
      </div>}
    </DialogContent>
  </Dialog>
}
