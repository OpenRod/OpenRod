import * as React from "react"
import { AppSidebar } from "@/components/app-sidebar"
import { SandboxesView } from "@/components/sandboxes-view"
import { ApprovalsView } from "@/components/approvals-view"
import { ActivityView } from "@/components/activity-view"
import { EgressView } from "@/components/egress-view"
import { IngressView } from "@/components/ingress-view"
import { SecretsView } from "@/components/secrets-view"
import { TemplatesView } from "@/components/templates-view"
import { GuardrailsView } from "@/components/guardrails-view"
import { OrgView } from "@/components/org-view"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { Toaster } from "@/components/ui/sonner"
import { LiveProvider } from "@/lib/live"

const TITLES = {
  sandboxes: "Sandboxes",
  approvals: "Approvals",
  activity: "Activity",
  organization: "Organization",
  egress: "Egress",
  ingress: "Ingress",
  secrets: "Secrets",
  templates: "Templates",
  guardrails: "Guardrails",
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

function viewFromLocation() {
  const view = window.location.hash.slice(1)
  return TITLES[view] ? view : "sandboxes"
}

export function App() {
  const [view, setView] = React.useState(viewFromLocation)
  React.useEffect(() => {
    const sync = () => setView(viewFromLocation())
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

  return (
    <LiveProvider>
      <SidebarProvider>
        <AppSidebar view={view} onNavigate={navigate} />
        <SidebarInset className="min-w-0 bg-background">
          <header className="flex h-14 shrink-0 items-center border-b border-border bg-card px-4 sm:px-8">
            <SidebarTrigger className="mr-2 md:hidden" />
            <h1 className="text-[18px] font-semibold tracking-tight">{TITLES[view]}</h1>
          </header>
          <PageBoundary view={view}>
          {view === "sandboxes" && <SandboxesView onNavigate={navigate} />}
          {view === "approvals" && <ApprovalsView />}
          {view === "activity" && <ActivityView />}
          {view === "organization" && <OrgView />}
          {view === "egress" && <EgressView onNavigate={navigate} />}
          {view === "ingress" && <IngressView />}
          {view === "secrets" && <SecretsView />}
          {view === "templates" && <TemplatesView />}
          {view === "guardrails" && <GuardrailsView />}
          </PageBoundary>
        </SidebarInset>
        <Toaster position="bottom-right" />
      </SidebarProvider>
    </LiveProvider>
  )
}
