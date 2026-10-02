import { ChevronRight } from "lucide-react"

// A collapsible row in a creation form's side panel; the summary shows what is set while closed.
export function FormSection({ title, summary, children, ...props }) {
  return (
    <details className="group/setup min-w-0 border-t border-border" {...props}>
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-sm py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open/setup:rotate-90" aria-hidden="true" />
        <span className="shrink-0 text-xs font-medium">{title}</span>
        <span className="ml-auto truncate text-right text-[11px] text-muted-foreground" title={summary}>{summary}</span>
      </summary>
      <div className="grid min-w-0 gap-4 pb-4 pt-1">{children}</div>
    </details>
  )
}
