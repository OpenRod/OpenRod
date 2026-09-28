import * as React from "react"
import { Check, ShieldAlert, Undo2, X } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { BorderBeam } from "@/components/ui/border-beam"
import { Spinner } from "@/components/ui/spinner"
import { api } from "@/lib/api"
import { useLive } from "@/lib/live"
import { relativeTime } from "@/lib/format"
import { destinationOf, programName } from "@/lib/sandboxes"

const QUICK_REASONS = ["Not needed for this task", "Telemetry — keep it blocked", "Host is not trusted"]

// One proposal the gateway's policy advisor drafted from a denied connection.
// Approving adds exactly this rule to that sandbox; nothing broader.
export function ApprovalCard({ chunk, compact = false, highlight = false }) {
  const { refreshApprovals } = useLive()
  const [busy, setBusy] = React.useState(null)
  const [rejecting, setRejecting] = React.useState(false)
  const [reason, setReason] = React.useState("")
  const destination = destinationOf(chunk)

  async function run(action, fn) {
    setBusy(action)
    try {
      await fn()
      toast.success(action === "approve" ? `Allowed ${destination} for ${chunk.sandbox}` : `Kept ${destination} blocked`)
      await refreshApprovals()
    } catch (error) {
      toast.error(error.message)
    } finally {
      setBusy(null)
      setRejecting(false)
    }
  }

  return (
    <div className={`relative overflow-hidden rounded-lg border bg-card ${compact ? "border-border/70 p-3" : "border-border p-4"}`}>
      {highlight && <BorderBeam size={70} duration={9} colorFrom="#f59e0b" colorTo="#fcd34d" borderWidth={1} />}
      <div className="flex items-start gap-3">
        <span className="mt-1 size-2 shrink-0 rounded-[2px] bg-amber-400" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className={`truncate font-mono font-medium tracking-tight ${compact ? "text-[12px]" : "text-[14px]"}`}>{destination}</p>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
            <span className="font-mono text-foreground/80">{programName(chunk.binary)}</span>
            {" "}· <span className="font-mono text-foreground/80">{chunk.sandbox}</span>
            {" "}· tried {chunk.hitCount}×
          </p>
          {!compact && (
            <p className="mt-2 truncate font-mono text-[11px] text-muted-foreground" title={`${chunk.binary ?? ""} · confidence ${Math.round(chunk.confidence * 100)}%`}>
              {chunk.ruleName}{chunk.prover ? ` · ${chunk.prover.replace(/^prover:\s*/, "")}` : ""}
            </p>
          )}
          {chunk.securityNotes && (
            <p className="mt-2 flex items-start gap-1.5 rounded-md border border-red-200 bg-red-50/60 px-2 py-1.5 text-[11px] text-red-700">
              <ShieldAlert className="mt-px size-3.5 shrink-0" aria-hidden="true" />{chunk.securityNotes}
            </p>
          )}
        </div>
        {!rejecting && (
          <div className="flex shrink-0 items-center gap-1.5">
            <Button size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => setRejecting(true)} aria-label={`Keep ${destination} blocked`}>
              <X aria-hidden="true" />{compact ? null : "Reject"}
            </Button>
            <Button size="sm" disabled={Boolean(busy)} onClick={() => run("approve", () => api.approve(chunk))}
              className="bg-[var(--action)] text-[var(--action-foreground)] hover:bg-[var(--action)]/90" aria-label={`Allow ${destination}`}>
              {busy === "approve" ? <Spinner aria-hidden="true" /> : <Check aria-hidden="true" />}{compact ? null : "Allow"}
            </Button>
          </div>
        )}
      </div>
      {rejecting && (
        <form className="mt-3 space-y-2 border-t border-border pt-3"
          onSubmit={(event) => { event.preventDefault(); if (reason.trim()) run("reject", () => api.reject(chunk, reason.trim())) }}>
          <label htmlFor={`reason-${chunk.id}`} className="text-[11px] font-medium">Why keep it blocked? <span className="font-normal text-muted-foreground">Can't be undone.</span></label>
          <div className="flex flex-wrap gap-1.5">
            {QUICK_REASONS.map((text) => (
              <button key={text} type="button" onClick={() => setReason(text)}
                className={`rounded border px-2 py-0.5 text-[11px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${reason === text ? "border-foreground/30 bg-accent" : "border-border text-muted-foreground hover:text-foreground"}`}>
                {text}
              </button>
            ))}
          </div>
          <Textarea id={`reason-${chunk.id}`} value={reason} onChange={(event) => setReason(event.target.value)} rows={2} className="text-xs" placeholder="Reason" autoFocus />
          <div className="flex justify-end gap-1.5">
            <Button type="button" size="sm" variant="ghost" onClick={() => setRejecting(false)}>Cancel</Button>
            <Button type="submit" size="sm" variant="destructive" disabled={!reason.trim() || Boolean(busy)}>
              {busy === "reject" && <Spinner aria-hidden="true" />}Keep blocked
            </Button>
          </div>
        </form>
      )}
    </div>
  )
}

export function DecisionRow({ chunk }) {
  const { refreshApprovals } = useLive()
  const [busy, setBusy] = React.useState(false)
  const approved = chunk.status === "approved"
  return (
    <div className="flex h-[34px] items-center gap-3 border-b border-border/50 px-4 text-[11px]" title={chunk.rejectionReason ?? undefined}>
      <span className={`size-2 shrink-0 rounded-[2px] ${approved ? "bg-emerald-500/85" : "bg-stone-300"}`} aria-hidden="true" />
      <span className="w-20 shrink-0 font-medium">{approved ? "Allowed" : "Kept blocked"}</span>
      <span className="min-w-0 flex-1 truncate font-mono">{destinationOf(chunk)}</span>
      <span className="hidden w-16 shrink-0 truncate font-mono text-muted-foreground md:block">{programName(chunk.binary)}</span>
      <span className="w-16 shrink-0 text-right font-mono tabular-nums text-muted-foreground">{chunk.decidedAt ? relativeTime(chunk.decidedAt) : ""}</span>
      {/* The gateway can take back an approval (removing the rule it added);
          a rejection is final, and the host reappears here only if retried. */}
      {approved ? (
        <Button variant="ghost" size="icon-sm" disabled={busy} aria-label={`Revoke access to ${destinationOf(chunk)}`} title="Revoke — remove this rule and block the host again"
          onClick={async () => {
            setBusy(true)
            try { await api.undo(chunk); toast.success(`Revoked ${destinationOf(chunk)}`); await refreshApprovals() } catch (error) { toast.error(error.message) } finally { setBusy(false) }
          }}>
          <Undo2 aria-hidden="true" className="size-3.5" />
        </Button>
      ) : <span className="size-7 shrink-0" aria-hidden="true" />}
    </div>
  )
}
