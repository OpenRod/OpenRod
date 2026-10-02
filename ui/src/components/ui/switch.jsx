"use client"

import { Switch as SwitchPrimitive } from "@base-ui/react/switch"

import { cn } from "@/lib/utils"

function Switch({ className, ...props }) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer relative inline-flex h-[18px] w-8 shrink-0 cursor-pointer items-center rounded-full border border-transparent outline-none transition-colors duration-200 focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-checked:bg-[var(--connection)] data-unchecked:bg-foreground/15",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-3.5 rounded-full bg-white shadow-sm ring-0 transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] data-checked:translate-x-[15px] data-unchecked:translate-x-[1px]"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
