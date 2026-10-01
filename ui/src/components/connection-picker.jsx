import * as React from "react"
import { RefreshCw } from "lucide-react"
import { api } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { SelectField } from "@/components/ui/select-field"
import { GatewaySetup } from "@/components/gateway-setup"

export function ConnectionPicker({ setupOpen, onSetupOpenChange }) {
  const [context, setContext] = React.useState(null)
  const [error, setError] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const [initialGateway, setInitialGateway] = React.useState(null)

  const refresh = React.useCallback(async () => {
    setBusy(true)
    try {
      const next = await api.context()
      setContext(next); setError(null)
      return next
    } catch (error) { setError(error.message); throw error }
    finally { setBusy(false) }
  }, [])

  React.useEffect(() => { refresh().catch(() => {}) }, [refresh])

  async function select(next) {
    setBusy(true); setError(null)
    try {
      await api.selectContext(next)
      window.location.reload()
    } catch (error) {
      setError(error.message)
      setBusy(false)
    }
  }

  function setUp(gateway = null) {
    setInitialGateway(gateway)
    onSetupOpenChange(true)
  }

  return (
    <section aria-label="Connection selection" className="grid gap-2 border-b border-sidebar-border pb-3 mb-3">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Connection</span>
        <Button variant="ghost" size="icon-xs" aria-label="Refresh gateway registrations" disabled={busy} onClick={() => refresh().catch(() => {})}>
          <RefreshCw className="size-3" />
        </Button>
      </div>
      {context?.gateways.length ? <>
        <label className="grid gap-1 text-[10px] text-muted-foreground">
          Gateway
          <SelectField aria-label="Select gateway" value={context.configured ? context.gateway : ""} disabled={busy || context.gatewayFixed} onChange={(e) => setUp(e.target.value)} className="w-full text-xs">
            {!context.configured && <option value="" disabled>Choose a registered gateway</option>}
            {context.gateways.map((gateway) => <option key={gateway.name} value={gateway.name} disabled={!gateway.supported}>{gateway.name}{gateway.error ? " (invalid registration)" : gateway.supported ? "" : ` (${gateway.authMode} unsupported)`}</option>)}
          </SelectField>
        </label>
        {context.configured && context.workspaces.length > 0 && <label className="grid gap-1 text-[10px] text-muted-foreground">
          Workspace
          <SelectField aria-label="Select workspace" value={context.workspace} disabled={busy || context.workspaceFixed} onChange={(e) => select({ workspace: e.target.value })} className="w-full text-xs">
            {context.workspaces.map((workspace) => <option key={workspace.name} value={workspace.name}>{workspace.name}</option>)}
          </SelectField>
        </label>}
        {(context.gatewayFixed || context.workspaceFixed) && <p className="text-[10px] text-muted-foreground">Selection is pinned by the server environment.</p>}
      </> : context && <p className="text-[11px] text-muted-foreground">No registered gateways. Setup shows the prerequisites, commands, and files you need. Nothing is installed automatically.</p>}
      {(error || context?.workspaceError) && <p role="alert" className="break-words text-[11px] text-destructive">{error || context.workspaceError}</p>}
      <Button variant="outline" size="sm" className="w-full text-xs" onClick={() => setUp()}>Set up connection</Button>
      <p className="text-[10px] text-muted-foreground">
        {context?.configured
          ? `Using ${context.selectionSource === "environment" ? "the server environment" : "your saved selection"}. Workspace changes update all console tabs; open terminals keep their target.`
          : "No gateway is connected. Check a connection and review its effects before using it."}
      </p>
      <GatewaySetup open={setupOpen} onOpenChange={onSetupOpenChange} context={context} onRefresh={refresh} initialGateway={initialGateway} />
    </section>
  )
}
