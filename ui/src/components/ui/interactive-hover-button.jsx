import { ArrowRight } from "lucide-react"

import { cn } from "@/lib/utils"

/*
 * Magic UI's interactive-hover-button, retoned for the desk: the fill is the warm
 * action accent rather than ink, the label sits at the list's type size, and the
 * motion is hover-only (nothing animates while the panel just sits open).
 */
export function InteractiveHoverButton({ children, className, disabled, ...props }) {
  return (
    <button
      disabled={disabled}
      className={cn(
        "group relative w-auto cursor-pointer overflow-hidden rounded-md border border-border bg-card px-4 py-1.5 text-center text-[13px] font-medium outline-none transition-colors",
        "focus-visible:ring-2 focus-visible:ring-ring",
        "disabled:pointer-events-none disabled:opacity-50",
        className
      )}
      {...props}
    >
      <div className="flex items-center justify-center gap-2">
        <div className="size-1.5 rounded-full bg-[var(--action)] transition-all duration-300 group-hover:scale-[100.8]" />
        <span className="inline-block transition-all duration-300 group-hover:translate-x-10 group-hover:opacity-0">
          {children}
        </span>
      </div>
      {/* The label is duplicated for the slide-in; hide the copy from assistive tech. */}
      <div
        aria-hidden="true"
        className="absolute top-0 z-10 flex h-full w-full translate-x-10 items-center justify-center gap-2 text-[var(--action-foreground)] opacity-0 transition-all duration-300 group-hover:-translate-x-4 group-hover:opacity-100"
      >
        <span>{children}</span>
        <ArrowRight className="size-3.5" />
      </div>
    </button>
  )
}
