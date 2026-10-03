import { useApi, useCompute } from '@/lib/compute'
import * as React from "react"
import { Loader2, Plus } from "lucide-react"
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
import { CloudAccount, useCloudMode } from "@/components/auth-gate"
import { LiveProvider, useLive } from "@/lib/live"
import { Button } from "@/components/ui/button"
import { LocationProvider } from "@/lib/location-context"
import { LocationBadge } from "@/components/location-badge"
import { connectLocalGateway } from "@/lib/locations"
import { CopyCommand } from "@/components/copy-command"
import { INSTALL_COMMAND } from "../shared/openshell-release.js"

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

function ScopedPage({ location, children }) {
  return location ? <LocationProvider location={location}><LiveProvider>{children}</LiveProvider></LocationProvider> : children
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

function ConnectionGate({ onSetup, onConnections, children }) {
  const api = useApi()
  const { connection, overview } = useLive()
  const gated = Boolean(onSetup) && connection === "setup-required"
  const [connections, setConnections] = React.useState(null)
  const [state, setState] = React.useState({ busy: false, error: null })
  React.useEffect(() => {
    if (!gated) return
    let alive = true
    api.connections().then((next) => { if (alive) setConnections(next) }).catch(() => { if (alive) setConnections({ locals: [] }) })
    return () => { alive = false }
  }, [gated, api])
  const locals = connections?.locals ?? null
  if (!onSetup) return children
  if (connection === "connecting" && !overview) return <section className="p-8">
    <p role="status" className="text-sm text-muted-foreground">Reading connection settings…</p>
  </section>
  if (!gated) return children
  async function chooseThisComputer() {
    setState({ busy: true, error: null })
    try {
      await connectLocalGateway(api, locals[0].name)
      window.location.reload()
    } catch (reason) { setState({ busy: false, error: reason.message }) }
  }
  const action = "bg-[var(--action)] text-[var(--action-foreground)] hover:bg-[var(--action)]/90"
  return (
    <section aria-labelledby="setup-heading" className="mx-auto my-16 grid w-full max-w-md justify-items-center gap-4 px-6 text-center">
      <h2 id="setup-heading" className="text-xl font-semibold tracking-tight">Choose where sandboxes run</h2>
      <p className="text-sm text-muted-foreground">Groups, network rules and secrets need a location. You don’t need a sandbox first.</p>
      <div className="flex flex-wrap justify-center gap-2">
        {locals?.length > 0 && <Button onClick={chooseThisComputer} disabled={state.busy} title={`Use the ${locals[0].name} gateway`} className={action}>{state.busy && <Loader2 aria-hidden="true" className="size-4 animate-spin" />}Use this computer</Button>}
        <Button variant="outline" onClick={onConnections}>Connect a remote machine</Button>
        <Button variant={locals?.length ? "ghost" : undefined} onClick={onSetup} className={locals?.length ? "" : action}><Plus aria-hidden="true" className="size-4" />New sandbox</Button>
      </div>
      {locals?.length === 0 && connections.tools?.openshell === false && <div className="grid w-full gap-2">
        <p className="text-xs text-muted-foreground">OpenShell isn’t installed. Install it in a terminal, then refresh this page.</p>
        <CopyCommand command={connections.tools.installCommand ?? INSTALL_COMMAND} />
      </div>}
      {state.error && <p role="alert" className="text-xs text-destructive">{state.error}</p>}
    </section>
  )
}

export function App() {
  const cloud = useCloudMode()
  const api = useApi()
  const compute = useCompute()
  const [view, setView] = React.useState(viewFromLocation)
  const [terminal, setTerminal] = React.useState(terminalFromLocation)
  const [createRequest, setCreateRequest] = React.useState(0)
  const [pageLocation, setPageLocation] = React.useState(locationFromHash)
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
  }, [])

  function navigate(next, location = null) {
    if (api.signal?.aborted || !TITLES[next]) return
    setView(next)
    setPageLocation(location)
    const params = location ? `?${new URLSearchParams({ gateway: location.gateway, workspace: location.workspace, label: location.label, remote: location.remote ? "1" : "0", ...(location.target ? { target: location.target } : {}) })}` : ""
    window.history.pushState(null, "", next === "sandboxes" && !location ? window.location.pathname : `#${next}${params}`)
  }

  if (terminal) {
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
    <LiveProvider>
      <SidebarProvider>
        <AppSidebar view={view} onNavigate={navigate} />
        <SidebarInset className="min-w-0 bg-background">
          <header className="flex h-14 shrink-0 items-center border-b border-border bg-card px-4 sm:px-6">
            <SidebarTrigger className="mr-2 md:hidden" />
            <h1 className="text-[18px] font-semibold tracking-tight">{TITLES[view]}</h1>
            {pageLocation && <span className="ml-3"><LocationBadge location={pageLocation} /></span>}
            <CloudAccount />
          </header>
          <SetupImportNotifications />
          <SandboxCreationNotifications />
          {!cloud && <GatewayDockerNotifications />}
          <PageBoundary key={`${view}:${pageLocation?.target ?? ""}:${pageLocation?.context ?? ""}`} view={view}>
          <ScopedPage location={pageLocation}>
          <ConnectionGate onSetup={view === "sandboxes" || view === "templates" || view === "connections" ? undefined : connectMachine} onConnections={() => navigate("connections")}>
          {view === "sandboxes" && <SandboxesView onNavigate={navigate} allowRemote={!cloud} createRequest={createRequest} onCreateRequestHandled={() => setCreateRequest(0)} />}
          {view === "activity" && <ActivityView />}
          {view === "groups" && <GroupsView onNavigate={navigate} />}
          {(view === "egress" || view === "ingress") && <NetworkView tab={view} onNavigate={navigate} />}
          {view === "secrets" && <SecretsView />}
          {view === "templates" && <TemplatesView />}
          {view === "setups" && <SetupsView />}
          {view === "connections" && !cloud && <ConnectionsView onCreateSandbox={connectMachine} />}
          </ConnectionGate>
          </ScopedPage>
          </PageBoundary>
        </SidebarInset>
        <Toaster position="bottom-right" />
      </SidebarProvider>
    </LiveProvider>
  )
}
