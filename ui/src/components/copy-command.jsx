import * as React from "react"
import { Check, Copy } from "lucide-react"

import { Button } from "@/components/ui/button"

export function CopyCommand({ command }) {
  const [copied, setCopied] = React.useState(false)
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-muted/40 py-1.5 pr-1.5 pl-3">
      <code className="min-w-0 flex-1 truncate font-mono text-[11px]" title={command}>{command}</code>
      <Button type="button" variant="ghost" size="icon-sm" aria-label="Copy command"
        onClick={async () => { await navigator.clipboard.writeText(command); setCopied(true); setTimeout(() => setCopied(false), 1500) }}>
        {copied ? <Check className="size-3.5 text-emerald-600" /> : <Copy className="size-3.5" />}
      </Button>
    </div>
  )
}
