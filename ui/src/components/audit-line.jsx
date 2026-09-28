// One decision the sandbox proxy made. Denials are the reason this page
// exists, so they carry the only colour; everything allowed stays quiet.
const clock = (at) => (at ? new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "")

const REASON = {
  policy_dns_ineligible: "no rule allows this host",
  transparent_tcp_policy_denied: "no rule allows this connection",
}
export const reasonText = (reason) => (reason ? REASON[reason] ?? reason : null)

export function AuditLine({ event, dense = false, showSandbox = false }) {
  const denied = event.verdict === "denied"
  return (
    <div className={`flex items-center gap-3 border-b border-border/50 px-3 font-mono text-[11px] last:border-b-0 ${dense ? "h-[26px]" : "h-[30px] px-4"} ${denied ? "bg-red-50/40" : ""}`}
      title={event.message}>
      <span className="w-[4.5rem] shrink-0 tabular-nums text-muted-foreground">{clock(event.at)}</span>
      <span className={`w-12 shrink-0 text-[10px] font-medium tracking-wide uppercase ${denied ? "text-red-600" : "text-emerald-700"}`}>{denied ? "Denied" : "Allowed"}</span>
      {showSandbox && <span className="hidden w-24 shrink-0 truncate text-muted-foreground md:block">{event.sandbox}</span>}
      {!dense && <span className="hidden w-20 shrink-0 truncate text-muted-foreground lg:block">{event.binary ? event.binary.split("/").pop() : event.category === "HTTP" ? event.method : "—"}</span>}
      <span className="min-w-0 flex-1 truncate">{event.method && dense ? `${event.method} ` : ""}{event.destination ?? event.detail}</span>
      {!dense && <span className="hidden w-56 shrink-0 truncate text-right text-[10px] text-muted-foreground xl:block">{denied ? reasonText(event.reason) : event.policy?.replace(/^_provider_/, "provider · ")}</span>}
    </div>
  )
}
