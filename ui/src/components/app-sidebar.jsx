import { Activity, Box, Building2, DoorOpen, FileLock2, Inbox, KeyRound, Network, ShieldCheck } from "lucide-react"

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
  { label: "Approvals", icon: Inbox, view: "approvals" },
  { label: "Activity", icon: Activity, view: "activity" },
]

const POLICIES = [
  { label: "Organization", icon: Building2, view: "organization" },
  { label: "Egress", icon: Network, view: "egress" },
  { label: "Ingress", icon: DoorOpen, view: "ingress" },
  { label: "Secrets", icon: KeyRound, view: "secrets" },
  { label: "Templates", icon: FileLock2, view: "templates" },
  { label: "Guardrails", icon: ShieldCheck, view: "guardrails" },
]

const CONNECTION = {
  live: { label: "Live", dot: "bg-emerald-500" },
  connecting: { label: "Connecting", dot: "bg-amber-400" },
  reconnecting: { label: "Reconnecting", dot: "bg-amber-400" },
  "gateway-down": { label: "Unreachable", dot: "bg-red-500" },
}

export function AppSidebar({ view, onNavigate }) {
  const { approvals, connection, overview } = useLive()
  const pending = approvals.pending.length
  const state = CONNECTION[connection] ?? CONNECTION.connecting
  const gateway = overview?.gateway

  return (
    <Sidebar collapsible="offcanvas" className="border-r border-sidebar-border">
      <SidebarHeader className="p-6">
        <div className="flex items-center gap-2">
          <img src="/openrod.svg" alt="" aria-hidden="true" className="h-7 w-auto shrink-0" />
          <span className="text-lg font-semibold tracking-tight">OpenShell</span>
        </div>
      </SidebarHeader>

      <SidebarContent className="px-3">
        <SidebarGroup className="p-0">
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV.map(({ label, icon: Icon, view: target }) => (
                <SidebarMenuItem key={target}>
                  <SidebarMenuButton isActive={view === target} onClick={() => onNavigate(target)}>
                    <Icon />
                    {label}
                    {target === "approvals" && pending > 0 && (
                      <span className="ml-auto flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 font-mono text-[10px] font-medium tabular-nums text-amber-800"
                        aria-label={`${pending} waiting for review`}>
                        {pending}
                      </span>
                    )}
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup className="p-0 pt-4">
          <SidebarGroupLabel className="px-3 text-[10px] font-bold tracking-widest text-faint uppercase">
            Policies
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {POLICIES.map(({ label, icon: Icon, view: target }) => (
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

      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border p-4">
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
              <dl className="grid gap-2.5">
                {[
                  ["Endpoint", gateway.endpoint, true],
                  ["Authentication", gateway.authMode === "mtls" ? "mTLS" : gateway.authMode],
                  ["Runtime", gateway.drivers.map((d) => `${d.driver}${d.version ? ` ${d.version}` : ""}`).join(", ") || "—", true],
                  ["Location", gateway.remote ? "Remote" : "This Mac"],
                ].map(([label, value, mono]) => (
                  <div key={label}>
                    <dt className="text-[10px] text-muted-foreground">{label}</dt>
                    <dd className={`break-all ${mono ? "font-mono text-[11px]" : "text-xs"}`}>{value}</dd>
                  </div>
                ))}
              </dl>
            ) : overview?.error ? <p className="font-mono text-[10px] text-muted-foreground">{overview.error}</p> : null}
          </PopoverContent>
        </Popover>
      </SidebarFooter>
    </Sidebar>
  )
}
