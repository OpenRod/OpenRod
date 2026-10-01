import * as React from "react"
import { Monitor } from "lucide-react"
import { SetupsView, SetupImportNotifications } from "@/components/setups-view"
import { AppSidebar } from "@/components/app-sidebar"
import { SandboxesView } from "@/components/sandboxes-view"
import { GatewaySetup } from "@/components/gateway-setup"
import { ActivityView } from "@/components/activity-view"
import { GroupsView } from "@/components/groups-view"
import { NetworkView } from "@/components/network-view"
import { SecretsView } from "@/components/secrets-view"
import { TemplatesView } from "@/components/image-templates-view"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { Toaster } from "@/components/ui/sonner"
import { CloudAccount, useCloudMode } from "@/components/auth-gate"
import { LiveProvider, useLive } from "@/lib/live"
import { Button } from "@/components/ui/button"
import { LocationProvider } from "@/lib/location-context"
import { LocationBadge } from "@/components/location-badge"

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
  return { context: JSON.stringify([gateway, workspace]), gateway, workspace, connected: true, remote, label: params.get("label") || (remote ? `SSH · ${gateway}` : "Local") }
}

function ScopedPage({ location, children }) {
  return location ? <LocationProvider location={location}><LiveProvider>{children}</LiveProvider></LocationProvider> : children
}

// A browser terminal is its own tab: `#terminal/<sandbox>?session=<program>`.
function terminalFromLocation() {
  const match = /^#terminal\/([a-z0-9-]{1,63})(?:\?(.*))?$/.exec(window.location.hash)
  if (!match) return null
  const params = new URLSearchParams(match[2] ?? "")
  const gateway = params.get("gateway"), workspace = params.get("workspace")
  const location = gateway && workspace ? { context: JSON.stringify([gateway, workspace]), gateway, workspace, connected: true } : null
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

function ConnectionGate({ onSetup, children }) {
  const { connection, overview } = useLive()
  if (!onSetup) return children
  if (connection === "connecting" && !overview) return <section className="space-y-4 p-8">
    <p role="status" className="text-sm text-muted-foreground">Reading connection settings…</p>
    <Button onClick={onSetup}><Monitor aria-hidden="true" className="size-4" />Connect machine</Button>
  </section>
  if (connection !== "setup-required") return children
  return (
    <section aria-labelledby="setup-heading" className="mx-auto my-12 w-full max-w-2xl space-y-6 px-6">
      <div className="space-y-2">
        <h2 id="setup-heading" className="text-2xl font-semibold">Choose where to run your sandboxes</h2>
        <p className="text-sm text-muted-foreground">Use your existing local gateway, or connect a remote Linux Docker host through an alias in your local SSH configuration. Both gateways run on this computer; your existing local gateway stays untouched.</p>
      </div>
      <ol className="list-decimal space-y-3 pl-5 text-sm">
        <li>Choose a local gateway or a concrete Host alias from <code>~/.ssh/config</code>.</li>
        <li>For a remote host, verify trusted key-based SSH access and a running Linux Docker engine. The console checks the required OpenShell runtime images.</li>
        <li>Missing OpenShell runtime images download automatically, or choose Upload package to provide a Docker-save archive. Docker must already be running; no gateway is installed remotely.</li>
        <li>Create a sandbox, or choose a ready sandbox and <strong>Open SSH in terminal</strong>.</li>
      </ol>
      <Button onClick={onSetup}><Monitor aria-hidden="true" className="size-4" />Connect machine</Button>
      <p className="text-xs text-muted-foreground">Connecting selects the gateway and reloads the console. Closing the console server disconnects the remote gateway and SSH tunnels; remote workloads and state are not deleted.</p>
    </section>
  )
}

export function App() {
  const cloud = useCloudMode()
  const [view, setView] = React.useState(viewFromLocation)
  const [terminal, setTerminal] = React.useState(terminalFromLocation)
  const [setupOpen, setSetupOpen] = React.useState(false)
  const [pageLocation, setPageLocation] = React.useState(locationFromHash)
  const connectMachine = cloud ? undefined : () => setSetupOpen(true)
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
  }, [])

  function navigate(next, location = null) {
    if (!TITLES[next]) return
    setView(next)
    setPageLocation(location)
    const params = location ? `?${new URLSearchParams({ gateway: location.gateway, workspace: location.workspace, label: location.label, remote: location.remote ? "1" : "0" })}` : ""
    window.history.pushState(null, "", next === "sandboxes" && !location ? window.location.pathname : `#${next}${params}`)
  }

  if (terminal) {
    return (
      <>
        <React.Suspense fallback={null}>
          <LocationProvider location={terminal.location}>
            <TerminalView key={`${terminal.location?.context ?? ""} ${terminal.name} ${terminal.session ?? ""}`} name={terminal.name} session={terminal.session} setupLogin={terminal.setupLogin} mcp={terminal.mcp} />
          </LocationProvider>
        </React.Suspense>
        <Toaster position="bottom-right" />
      </>
    )
  }

  return (
    <LiveProvider>
      <SidebarProvider>
        <AppSidebar view={view} onNavigate={navigate} />
        <SidebarInset className="min-w-0 bg-background">
          <header className="flex h-14 shrink-0 items-center border-b border-border bg-card px-4 sm:px-8">
            <SidebarTrigger className="mr-2 md:hidden" />
            <h1 className="text-[18px] font-semibold tracking-tight">{TITLES[view]}</h1>
            {pageLocation && <span className="ml-3"><LocationBadge location={pageLocation} /></span>}
            <CloudAccount />
          </header>
          <SetupImportNotifications />
          <PageBoundary key={`${view}:${pageLocation?.context ?? ""}`} view={view}>
          <ScopedPage location={pageLocation}>
          <ConnectionGate onSetup={view === "sandboxes" || view === "templates" ? undefined : connectMachine}>
          {view === "sandboxes" && <SandboxesView onNavigate={navigate} onConnect={connectMachine} />}
          {view === "activity" && <ActivityView />}
          {view === "groups" && <GroupsView onNavigate={navigate} />}
          {(view === "egress" || view === "ingress") && <NetworkView tab={view} onNavigate={navigate} />}
          {view === "secrets" && <SecretsView />}
          {view === "templates" && <TemplatesView />}
          {view === "setups" && <SetupsView />}
          </ConnectionGate>
          </ScopedPage>
          </PageBoundary>
        </SidebarInset>
        {!cloud && <GatewaySetup open={setupOpen} onOpenChange={setSetupOpen} initialMode="ssh" />}
        <Toaster position="bottom-right" />
      </SidebarProvider>
    </LiveProvider>
  )
}
