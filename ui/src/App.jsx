import { useApi, useCompute } from '@/lib/compute'
import * as React from "react"
import { SetupsView, SetupImportNotifications } from "@/components/setups-view"
import { SandboxCreationNotifications } from "@/components/sandbox-creation-notices"
import { GatewayDockerNotifications } from "@/components/gateway-docker"
import { AppSidebar } from "@/components/app-sidebar"
import { SandboxesView } from "@/components/sandboxes-view"
import { ActivityView } from "@/components/activity-view"
import { GroupsView } from "@/components/groups-view"
import { NetworkView } from "@/components/network-view"
import { SecretsView } from "@/components/secrets-view"
import { TemplatesView } from "@/components/image-templates-view"
import { ConnectionsView } from "@/components/connections-view"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { Toaster } from "@/components/ui/sonner"
import { CloudAccount } from "@/components/auth-gate"
import { LiveProvider, useLive } from "@/lib/live"
import { LocationProvider } from "@/lib/location-context"
import { useInventory } from "@/lib/inventory"
import { workingLocation, locationIdentity } from "@/lib/working-location"
import { ResourceImportDialog } from '@/components/resource-import-dialog'
import { CloudAnnouncement } from '@/components/cloud-announcement'
import { analytics } from '@/lib/analytics'
import { useUsageState } from '@/components/usage-feedback'

// xterm.js is only needed by terminal tabs.
const TerminalView = React.lazy(() => import("@/components/terminal-view").then((m) => ({ default: m.TerminalView })))

const TITLES = {
  sandboxes: "Sandboxes",
  activity: "Activity",
  groups: "Groups",
  egress: "Network",
  ingress: "Network",
  secrets: "Secrets",
  templates: "Templates",
  setups: "MCPs & Skills",
  connections: "Connections",
}

// One page failing to render must not take the console down with it.
class PageBoundary extends React.Component {
  state = { error: null }
  static getDerivedStateFromError(error) { return { error } }
  componentDidUpdate(previous) { if (previous.view !== this.props.view && this.state.error) this.setState({ error: null }) }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div role="alert" className="mx-auto mt-10 max-w-md rounded-lg border border-border p-5 text-center text-sm">
        <p>This page hit an error.</p>
        <p className="mt-1 font-mono text-[11px] text-muted-foreground">{this.state.error.message}</p>
        <button className="mt-3 text-xs underline underline-offset-2" onClick={() => this.setState({ error: null })}>Try again</button>
      </div>
    )
  }
}

function locationFromHash() {
  const params = new URLSearchParams(window.location.hash.split("?")[1] ?? "")
  const gateway = params.get("gateway"), workspace = params.get("workspace")
  if (!gateway || !workspace) return null
  const remote = params.get("remote") === "1"
  const target = params.get("target") ?? new URLSearchParams(window.location.search).get("target") ?? undefined
  return { id: JSON.stringify([target ?? "local", JSON.stringify([gateway, workspace])]), context: JSON.stringify([gateway, workspace]), gateway, workspace, connected: true, remote, target, cloud: target === "cloud", label: params.get("label") || (remote ? `SSH · ${gateway}` : "Local") }
}

// A browser terminal is its own tab: `#terminal/<sandbox>?session=<program>`.
function terminalFromLocation() {
  const match = /^#terminal\/([a-z0-9-]{1,63})(?:\?(.*))?$/.exec(window.location.hash)
  if (!match) return null
  const params = new URLSearchParams(match[2] ?? "")
  const gateway = params.get("gateway"), workspace = params.get("workspace")
  const location = gateway && workspace ? { context: JSON.stringify([gateway, workspace]), gateway, workspace, connected: true, remote: params.get('remote') === '1', target: new URLSearchParams(window.location.search).get("target") ?? undefined } : null
  return { name: match[1], session: params.get("session") || undefined, setupLogin: params.get("setupLogin") || undefined, mcp: params.get("mcp") || undefined, location }
}

function viewFromLocation() {
  const view = window.location.hash.slice(1).split("?")[0]
  if (view === "policies") {
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#egress`)
    return "egress"
  }
  if (view === "guardrails") {
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#activity`)
    return "activity"
  }
  return TITLES[view] ? view : "sandboxes"
}

// Reports once how the console opened, after its connection state is known.
function ConsoleOpened() {
  const { connection } = useLive()
  const usage = useUsageState()
  React.useEffect(() => { analytics.observeConsole(connection) }, [connection, usage.sharing])
  return null
}

export function App() {
  const api = useApi()
  const compute = useCompute()
  const cloud = !compute?.localViewer
  const [view, setView] = React.useState(viewFromLocation)
  const [terminal, setTerminal] = React.useState(terminalFromLocation)
  const [createRequest, setCreateRequest] = React.useState(0)
  const [pageLocation, setPageLocation] = React.useState(locationFromHash)
  const usage = useUsageState()
  React.useEffect(() => { analytics.observeView(terminal ? 'terminal' : view) }, [view, Boolean(terminal), usage.sharing])
  const [importRequest, setImportRequest] = React.useState(null)
  const inventory = useInventory()
  const location = React.useMemo(() => workingLocation(inventory.locations, null, api.target ?? 'local'), [inventory.locations, api.target])
  const navigate = React.useCallback((next, requestedLocation) => {
    const nextLocation = requestedLocation ?? null
    if (api.signal?.aborted || !TITLES[next]) return
    setView(next)
    setPageLocation(nextLocation)
    const params = nextLocation ? `?${new URLSearchParams({ gateway: nextLocation.gateway, workspace: nextLocation.workspace, label: nextLocation.label, remote: nextLocation.remote ? "1" : "0", ...(nextLocation.target ? { target: nextLocation.target } : {}) })}` : ""
    window.history.pushState(null, "", next === "sandboxes" && !nextLocation ? window.location.pathname : `#${next}${params}`)
  }, [api.signal])
  const connectMachine = cloud ? undefined : () => { navigate("sandboxes"); setCreateRequest((value) => value + 1) }
  React.useEffect(() => {
    const sync = () => { setView(viewFromLocation()); setTerminal(terminalFromLocation()); setPageLocation(locationFromHash()) }
    window.addEventListener("popstate", sync)
    window.addEventListener("hashchange", sync)
    const scopedNavigate = (event) => navigate(event.detail.view, event.detail.location)
    window.addEventListener("openrod-navigate", scopedNavigate)
    return () => {
      window.removeEventListener("popstate", sync)
      window.removeEventListener("hashchange", sync)
      window.removeEventListener("openrod-navigate", scopedNavigate)
    }
  }, [navigate])
  React.useEffect(() => {
    const open = event => setImportRequest({ ...event.detail, type: event.detail?.type ?? event.detail?.types?.[0], key: Date.now() })
    window.addEventListener('openrod-import', open)
    return () => window.removeEventListener('openrod-import', open)
  }, [])

  if (terminal) {
    // A fresh terminal tab must resolve its cloud owner before issuing requests.
    // Otherwise its first request can race account discovery and invalidate it.
    if (terminal.location?.target === 'cloud' && compute?.localViewer && (compute.checking || !compute.connected)) {
      return <main className="grid min-h-svh place-items-center p-6"><section className="text-center text-sm">
        <p role="status">{compute.checking ? 'Checking cloud connection…' : 'Connect to OpenRod Cloud to open this terminal.'}</p>
        {!compute.checking && <a href="#connections" className="mt-4 inline-block underline underline-offset-4">Open Connections</a>}
      </section></main>
    }
    return (
      <>
        <React.Suspense fallback={null}>
          <LocationProvider location={terminal.location}>
            <TerminalView key={`${compute?.target} ${terminal.location?.context ?? ""} ${terminal.name} ${terminal.session ?? ""}`} name={terminal.name} session={terminal.session} setupLogin={terminal.setupLogin} mcp={terminal.mcp} />
          </LocationProvider>
        </React.Suspense>
        <Toaster position="bottom-right" />
      </>
    )
  }

  return (
    <LocationProvider location={location}><LiveProvider key={locationIdentity(location) ?? 'unscoped'}>
      <ConsoleOpened />
      <SidebarProvider>
        <AppSidebar view={view} onNavigate={navigate} />
        <SidebarInset className="min-w-0 bg-background">
          <CloudAnnouncement />
          <header className="flex h-14 shrink-0 items-center border-b border-border bg-card px-4 sm:px-6">
            <SidebarTrigger className="mr-2 md:hidden" />
            <h1 className="text-[18px] font-semibold tracking-tight">{TITLES[view]}</h1>
            <CloudAccount />
          </header>
          <SetupImportNotifications />
          <SandboxCreationNotifications />
          {!cloud && <GatewayDockerNotifications />}
          <PageBoundary key={`${view}:${locationIdentity(location) ?? 'unscoped'}`} view={view}>

          {view === "sandboxes" && <SandboxesView onNavigate={navigate} allowRemote={!cloud} createRequest={createRequest} onCreateRequestHandled={() => setCreateRequest(0)} />}
          {view === "activity" && <ActivityView combined />}
          {view === "groups" && <GroupsView combined onNavigate={navigate} />}
          {(view === "egress" || view === "ingress") && <NetworkView combined tab={view} onNavigate={navigate} requestedLocation={pageLocation} />}
          {view === "secrets" && <SecretsView combined />}
          {view === "templates" && <TemplatesView />}
          {view === "setups" && <SetupsView combined />}
          {view === "connections" && !cloud && <ConnectionsView onCreateSandbox={connectMachine} />}

          </PageBoundary>
        </SidebarInset>
        <Toaster position="bottom-right" />
        {importRequest && <ResourceImportDialog key={importRequest.key} request={importRequest} onClose={() => setImportRequest(null)} />}
      </SidebarProvider>
    </LiveProvider></LocationProvider>
  )
}
