import { KeyRound } from "lucide-react"
import { cn } from "@/lib/utils"
import { logoOf } from "@/lib/services"

// A brand mark on a small hard-edged tile, the same object language as the
// status cells: square, hairline border, a whisper of depth.
export function ServiceLogo({ type, size = "md", className }) {
  const src = logoOf(type)
  const box = size === "lg" ? "size-10 rounded-lg" : size === "sm" ? "size-6 rounded-md" : "size-8 rounded-md"
  const img = size === "lg" ? "size-5" : size === "sm" ? "size-3.5" : "size-[18px]"
  return (
    <span className={cn("flex shrink-0 items-center justify-center border border-border/80 bg-linear-to-b from-background to-muted/50 shadow-[0_1px_2px_#00000008]", box, className)}>
      {src ? <img src={src} alt="" aria-hidden="true" className={cn("object-contain", img)} draggable={false} />
        : <KeyRound strokeWidth={1.4} className={cn("text-muted-foreground", img)} aria-hidden="true" />}
    </span>
  )
}
