import { Monitor, Moon, Sun } from "lucide-react"
import { motion, useReducedMotion } from "motion/react"
import { useTheme } from "next-themes"
import { ShineBorder } from "@/components/ui/shine-border"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

const MODES = [
  { value: "light", label: "Light mode", icon: Sun },
  { value: "dark", label: "Dark mode", icon: Moon },
  { value: "system", label: "Auto · Follow computer", icon: Monitor },
]

export function ThemeSwitcher() {
  const { theme = "system", setTheme } = useTheme()
  const reducedMotion = useReducedMotion()
  const selected = Math.max(0, MODES.findIndex((mode) => mode.value === theme))

  return <TooltipProvider delay={200}>
    <ToggleGroup aria-label="Appearance" value={[theme]} onValueChange={(values) => {
      if (values.length) setTheme(values[0])
    }} spacing={1} className="relative isolate mb-3 gap-1 rounded-xl border border-sidebar-border bg-background/70 p-1 shadow-[inset_0_1px_3px_#00000008]">
      <motion.span aria-hidden="true" initial={false} animate={{ x: selected * 36 }}
        transition={reducedMotion ? { duration: 0 } : { type: "spring", stiffness: 450, damping: 32 }}
        className="pointer-events-none absolute left-1 top-1 size-8 rounded-lg border border-border bg-card shadow-[0_2px_4px_#00000014,inset_0_1px_0_var(--button-highlight)]">
        <ShineBorder duration={12} shineColor={["var(--border)", "var(--frame-highlight)", "var(--ink-faint)"]} />
      </motion.span>
      {MODES.map(({ value, label, icon: Icon }) => <Tooltip key={value}>
        <TooltipTrigger render={<ToggleGroupItem value={value} aria-label={label} />}
          className={cn("relative z-10 size-8 min-w-8 rounded-lg p-0 text-muted-foreground hover:bg-transparent aria-pressed:bg-transparent data-[state=on]:bg-transparent motion-reduce:transition-none", theme === value && "text-foreground")}>
          <motion.span aria-hidden="true" initial={false}
            animate={{ rotate: theme === value && value === "light" ? 45 : theme === value && value === "dark" ? -12 : 0, scale: theme === value ? 1 : 0.9 }}
            transition={{ duration: reducedMotion ? 0 : 0.22 }} className="flex items-center justify-center">
            <Icon className="size-3.5" strokeWidth={1.7} />
          </motion.span>
        </TooltipTrigger>
        <TooltipContent side="top">{label}</TooltipContent>
      </Tooltip>)}
    </ToggleGroup>
  </TooltipProvider>
}
