import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { CLOUD_SOON } from '@/lib/cloud-origin'
import { cn } from '@/lib/utils'

// A visible but inert cloud control: it stays focusable so its tooltip can explain why, and never acts.
export function CloudSoon({ children, className, variant = 'outline', size = 'sm' }) {
  return <TooltipProvider delay={200}><Tooltip>
    <TooltipTrigger render={<Button type="button" variant={variant} size={size} disabled focusableWhenDisabled className={cn('cursor-not-allowed opacity-50', className)} />}>
      {children}<span className="sr-only"> {CLOUD_SOON}</span>
    </TooltipTrigger>
    <TooltipContent side="bottom" className="max-w-60">{CLOUD_SOON}</TooltipContent>
  </Tooltip></TooltipProvider>
}
