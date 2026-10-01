import * as React from "react"
import { SetupsView, SetupImportNotifications } from "@/components/setups-view"
import { AppSidebar } from "@/components/app-sidebar"
import { SandboxesView } from "@/components/sandboxes-view"
import { ActivityView } from "@/components/activity-view"
import { GroupsView } from "@/components/groups-view"
import { NetworkView } from "@/components/network-view"
import { SecretsView } from "@/components/secrets-view"
import { TemplatesView } from "@/components/image-templates-view"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { Toaster } from "@/components/ui/sonner"
import { LiveProvider } from "@/lib/live"

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

// A browser terminal is its own tab: `#terminal/<sandbox>?session=<program>`.
function terminalFromLocation() {
  const match = /^#terminal\/([a-z0-9-]{1,63})(?:\?(.*))?$/.exec(window.location.hash)
  if (!match) return null
  const params = new URLSearchParams(match[2] ?? "")
  return { name: match[1], session: params.get("session") || undefined, setupLogin: params.get("setupLogin") || undefined, mcp: params.get("mcp") || undefined }
}

function viewFromLocation() {
  const view = window.location.hash.slice(1)
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

export function App() {
  const [view, setView] = React.useState(viewFromLocation)
  const [terminal, setTerminal] = React.useState(terminalFromLocation)
  React.useEffect(() => {
    const sync = () => { setView(viewFromLocation()); setTerminal(terminalFromLocation()) }
    window.addEventListener("popstate", sync)
    window.addEventListener("hashchange", sync)
    return () => {
      window.removeEventListener("popstate", sync)
      window.removeEventListener("hashchange", sync)
    }
  }, [])

  function navigate(next) {
    if (!TITLES[next]) return
    setView(next)
    window.history.pushState(null, "", next === "sandboxes" ? window.location.pathname : `#${next}`)
  }

  if (terminal) {
    return (
      <>
        <React.Suspense fallback={null}>
          <TerminalView key={`${terminal.name} ${terminal.session ?? ""}`} name={terminal.name} session={terminal.session} setupLogin={terminal.setupLogin} mcp={terminal.mcp} />
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
          </header>
          <SetupImportNotifications />
          <PageBoundary view={view}>
          {view === "sandboxes" && <SandboxesView onNavigate={navigate} />}
          {view === "activity" && <ActivityView />}
          {view === "groups" && <GroupsView onNavigate={navigate} />}
          {(view === "egress" || view === "ingress") && <NetworkView tab={view} onNavigate={navigate} />}
          {view === "secrets" && <SecretsView />}
          {view === "templates" && <TemplatesView />}
          {view === "setups" && <SetupsView />}
          </PageBoundary>
        </SidebarInset>
        <Toaster position="bottom-right" />
      </SidebarProvider>
    </LiveProvider>
  )
}
