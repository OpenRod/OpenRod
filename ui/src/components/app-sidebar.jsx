import { ThemeSwitcher } from "@/components/theme-switcher"
import * as React from "react"
import { Activity, Package, Box, DoorOpen, Layers3, Inbox, KeyRound, Network, Server, Users, Cable } from "lucide-react"

import { Button } from "@/components/ui/button"
import { api } from "@/lib/api"

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
import { UsageButton } from './usage-feedback'

const ENVIRONMENT = [
  { label: "Sandboxes", icon: Box, view: "sandboxes" },
  { label: "Templates", icon: Layers3, view: "templates" },
  { label: "MCPs & Skills", icon: Package, view: "setups" },
  { label: "Activity", icon: Activity, view: "activity" },
  { label: "Connections", icon: Cable, view: "connections" },
]

// Network is one page with Egress and Ingress tabs; each tab is its own view,
// and clicking Network while on a tab keeps that tab.
const SECURITY = [
  { label: "Groups", icon: Users, view: "groups" },
  { label: "Network", icon: Network, view: "egress", also: ["ingress"] },
  { label: "Secrets", icon: KeyRound, view: "secrets" },
]

const CONNECTION = {
  live: { label: "Live", dot: "bg-emerald-500" },
  connecting: { label: "Connecting", dot: "bg-amber-400" },
  reconnecting: { label: "Reconnecting", dot: "bg-amber-400" },
  "gateway-down": { label: "Unreachable", dot: "bg-red-500" },
  "setup-required": { label: "Not connected", dot: "bg-muted-foreground" },
}

export function AppSidebar({ view, onNavigate }) {
  const { connection, overview } = useLive()
  const state = CONNECTION[connection] ?? CONNECTION.connecting
  const gateway = overview?.gateway

  return (
    <Sidebar collapsible="offcanvas" className="border-r border-sidebar-border">
      <SidebarHeader className="h-14 shrink-0 justify-center px-6 py-0">
        <div className="flex items-center gap-2">
          <span className="sidebar-icon-hover inline-flex shrink-0">
            <img src="/openrod.png" alt="" aria-hidden="true" className="sidebar-icon size-9 object-contain" />
          </span>
          <span className="flex flex-col leading-none">
            <span className="sidebar-wordmark text-lg font-normal tracking-tight whitespace-nowrap">OpenRod</span>
            <span className="mt-0.5 text-[10px] whitespace-nowrap text-muted-foreground">for OpenShell</span>
          </span>
        </div>
      </SidebarHeader>

      <SidebarContent className="px-3 pt-4">
        <SidebarGroup className="p-0">
          <SidebarGroupLabel className="px-3 text-[10px] font-bold tracking-widest text-faint uppercase">
            Environment
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {ENVIRONMENT.map(({ label, icon: Icon, view: target }) => (
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
              {SECURITY.map(({ label, icon: Icon, view: target, also = [] }) => (
                <SidebarMenuItem key={target}>
                  <SidebarMenuButton isActive={view === target || also.includes(view)} onClick={() => onNavigate(also.includes(view) ? view : target)}>
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
        <UsageButton />
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
              {gateway ? (gateway.status === "healthy" ? "Healthy" : gateway.status) : connection === "setup-required" ? "No connection selected" : overview?.error ? "Unreachable" : "Reading…"}
            </p>
            {gateway ? (
              <dl className="grid gap-2.5">
                {[
                  ["Endpoint", gateway.endpoint, true],
                  ["Authentication", gateway.authMode === "mtls" ? "mTLS" : gateway.authMode],
                  ["Runtime", gateway.drivers.map((d) => `${d.driver}${d.version ? ` ${d.version}` : ""}`).join(", ") || "-", true],
                  ["Registration", gateway.remote ? "Remote" : "Local / tunnel endpoint"],
                ].map(([label, value, mono]) => (
                  <div key={label}>
                    <dt className="text-[10px] text-muted-foreground">{label}</dt>
                    <dd className={`break-all ${mono ? "font-mono text-[11px]" : "text-xs"}`}>{value}</dd>
                  </div>
                ))}
              </dl>
            ) : overview?.error ? <p className="font-mono text-[10px] text-muted-foreground">{overview.error}</p> : null}
            <RemoteMachine />
          </PopoverContent>
        </Popover>
      </SidebarFooter>
    </Sidebar>
  )
}

// The SSH machine is a second location next to the gateway above; this is where it is disconnected.
function RemoteMachine() {
  const [remote, setRemote] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState(null)
  React.useEffect(() => {
    let alive = true
    api.connections().then((next) => { if (alive) setRemote(next.active) }).catch(() => {})
    return () => { alive = false }
  }, [])
  if (!remote || remote.status !== "connected") return null
  async function disconnect() {
    setBusy(true); setError(null)
    try { await api.disconnectRemote(); setRemote(null) } catch (reason) { setError(reason.message) } finally { setBusy(false) }
  }
  return <div className="grid gap-2 border-t border-border pt-3">
    <div className="flex items-center gap-2">
      <Server aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium">{remote.host}</span>
        <span className="block text-[10px] text-muted-foreground">SSH machine · connected</span>
      </span>
      <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" disabled={busy} onClick={disconnect}>{busy ? "Disconnecting…" : "Disconnect"}</Button>
    </div>
    {error && <p role="alert" className="text-[10px] text-destructive">{error}</p>}
  </div>
}
