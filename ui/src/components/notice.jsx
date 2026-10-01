import * as React from "react"
import { toast } from "sonner"
import { Check, Info, OctagonX, TriangleAlert, X } from "lucide-react"
import { Spinner } from "@/components/ui/spinner"

const TONES = {
  info: { icon: <Info className="size-4 text-muted-foreground" />, role: "status" },
  progress: { icon: <Spinner className="size-4 text-muted-foreground" />, role: "status" },
  success: { icon: <Check className="size-4 text-emerald-600" />, role: "status" },
  warning: { icon: <TriangleAlert className="size-4 text-amber-600" />, role: "alert" },
  error: { icon: <OctagonX className="size-4 text-destructive" />, role: "alert" },
}

function NoticeCard({ tone = "info", title, children, actions, onDismiss, dismissLabel }) {
  const { icon, role } = TONES[tone]
  return (
    <div role={role} className="flex w-[var(--width)] max-w-full gap-3 rounded-[var(--radius)] border border-border bg-popover p-4 text-xs text-popover-foreground shadow-lg">
      <span className="mt-px shrink-0" aria-hidden="true">{icon}</span>
      <div className="min-w-0 flex-1">
        {title && <p className="break-words font-medium">{title}</p>}
        {children && <div className="mt-0.5 break-words text-muted-foreground">{children}</div>}
        {actions && <div className="mt-2.5 flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {onDismiss && <button type="button" aria-label={dismissLabel ?? "Dismiss notification"} onClick={onDismiss}
        className="-mt-1 -mr-1 size-6 shrink-0 rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        <X className="mx-auto size-3.5" /></button>}
    </div>
  )
}

// A notification in the bottom-right stack that stays while it is rendered.
// The owner keeps the state: the card updates in place as props change and
// leaves when the component unmounts or the owner dismisses it.
export function Notice({ id, ...props }) {
  // Sent after the commit: the Toaster only hears toasts raised once it has
  // subscribed, and it can mount later than a notice rendered above it.
  React.useEffect(() => {
    const timer = setTimeout(() => toast.custom(() => <NoticeCard {...props} />, { id, duration: Infinity, dismissible: false, unstyled: true }))
    return () => clearTimeout(timer)
  })
  React.useEffect(() => () => { toast.dismiss(id) }, [id])
  return null
}
