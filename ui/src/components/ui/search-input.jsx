import { Search, X } from "lucide-react"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

// The console's one search field: thin, near-square, with a clear button once
// there is a query. `className` sizes the wrapper; the field fills it.
function SearchInput({ value, onValueChange, className, ref, ...props }) {
  return (
    <div className={cn("relative", className)}>
      <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input ref={ref} value={value} onChange={(e) => onValueChange(e.target.value)} className="h-7 rounded-[3px] pr-7 pl-8 text-xs focus-visible:ring-1" {...props} />
      {value && <button type="button" aria-label="Clear search" className="absolute top-1/2 right-2 -translate-y-1/2" onClick={() => onValueChange("")}><X className="size-3.5" /></button>}
    </div>
  )
}

export { SearchInput }
