import { ThemeSwitcher } from "@/components/theme-switcher"
import { Activity, Package, Box, Building2, DoorOpen, Layers3, Inbox, KeyRound, Network, Users } from "lucide-react"

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import { useLive } from "@/lib/live"

const NAV = [
  { label: "Sandboxes", icon: Box, view: "sandboxes" },
  { label: "Templates", icon: Layers3, view: "templates" },
  { label: "MCPs & Skills", icon: Package, view: "setups" },
  { label: "Activity", icon: Activity, view: "activity" },
]

// Network is one page with Egress and Ingress tabs; each tab is its own view,
// and clicking Network while on a tab keeps that tab.
const SECURITY = [
  { label: "Organization", icon: Building2, view: "organization", disabled: true },
  { label: "Groups", icon: Users, view: "groups" },
  { label: "Network", icon: Network, view: "egress", also: ["ingress"] },
  { label: "Secrets", icon: KeyRound, view: "secrets" },
]

const CONNECTION = {
  live: { label: "Live", dot: "bg-emerald-500" },
  connecting: { label: "Connecting", dot: "bg-amber-400" },
  reconnecting: { label: "Reconnecting", dot: "bg-amber-400" },
  "gateway-down": { label: "Unreachable", dot: "bg-red-500" },
}

export function AppSidebar({ view, onNavigate }) {
  const { connection, overview } = useLive()
  const state = CONNECTION[connection] ?? CONNECTION.connecting
  const gateway = overview?.gateway

  return (
    <Sidebar collapsible="offcanvas" className="border-r border-sidebar-border">
      <SidebarHeader className="h-14 shrink-0 justify-center px-6 py-0">
        <div className="flex items-center gap-2">
          <img src="/openegg.png" alt="" aria-hidden="true" className="size-9 shrink-0 object-contain" />
          <span className="sidebar-wordmark text-lg font-normal tracking-tight whitespace-nowrap">OpenEgg Shell</span>
        </div>
      </SidebarHeader>

      <SidebarContent className="px-3 pt-4">
        <SidebarGroup className="p-0">
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV.map(({ label, icon: Icon, view: target }) => (
                <SidebarMenuItem key={target}>
                  <SidebarMenuButton isActive={view === target} onClick={() => onNavigate(target)}>
                    <Icon />
                    {label}
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup className="p-0 pt-4">
          <SidebarGroupLabel className="px-3 text-[10px] font-bold tracking-widest text-faint uppercase">
            Security
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {SECURITY.map(({ label, icon: Icon, view: target, also = [], disabled }) => (
                <SidebarMenuItem key={target}>
                  <SidebarMenuButton disabled={disabled} isActive={!disabled && (view === target || also.includes(view))}
                    onClick={disabled ? undefined : () => onNavigate(also.includes(view) ? view : target)}
                    className={disabled ? "h-auto items-start text-muted-foreground" : undefined}>
                    <Icon className={disabled ? "mt-0.5" : undefined} />
                    <span>
                      <span className="block">{label}</span>
                      {disabled && <span className="block text-[10px]">Enterprise Version</span>}
                    </span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border p-4">
        <ThemeSwitcher />
        {/* The gateway is status, not a destination: its facts live here. */}
        <Popover>
          <PopoverTrigger className="flex w-full items-center gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
            aria-label="Gateway details">
            <span className="relative flex size-1.5 shrink-0" aria-hidden="true">
              {connection === "live" && <span className="absolute inline-flex size-full rounded-full bg-emerald-400/55 motion-safe:animate-ping" />}
              <span className={`relative inline-flex size-1.5 rounded-full ${state.dot}`} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium">{gateway?.name ?? "Gateway"}</span>
              <span className="block truncate font-mono text-[10px] text-muted-foreground">
                {state.label}{gateway?.version ? ` · v${gateway.version}` : ""}
              </span>
            </span>
          </PopoverTrigger>
          <PopoverContent side="top" align="start" sideOffset={10} className="w-64 gap-3 p-4">
            <p className="flex items-center gap-1.5 text-xs font-medium">
              <span className={`size-1.5 rounded-full ${gateway?.status === "healthy" ? "bg-emerald-500" : "bg-red-500"}`} aria-hidden="true" />
              {gateway ? (gateway.status === "healthy" ? "Healthy" : gateway.status) : overview?.error ? "Unreachable" : "Reading…"}
            </p>
            {gateway ? (
              <dl>
                <dt className="text-[10px] text-muted-foreground">Gateway endpoint</dt>
                <dd className="break-all font-mono text-[11px]">{gateway.endpoint}</dd>
              </dl>
            ) : overview?.error ? <p className="font-mono text-[10px] text-muted-foreground">{overview.error}</p> : null}
          </PopoverContent>
        </Popover>
      </SidebarFooter>
    </Sidebar>
  )
}
