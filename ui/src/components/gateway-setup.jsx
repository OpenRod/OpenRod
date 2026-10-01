import * as React from "react"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { SelectField } from "@/components/ui/select-field"
import { CopyCommand } from "@/components/copy-command"
import { api } from "@/lib/api"
import { registrationPlan } from "@/lib/gateway-setup"

const STAGES = ["Prerequisites", "Registration", "Check connection", "Review & activate"]

function Field({ label, id, value, onChange, help, ...props }) {
  return <div className="grid gap-1.5">
    <Label htmlFor={id} className="text-xs">{label}</Label>
    <Input id={id} value={value} onChange={(event) => onChange(event.target.value)} aria-describedby={help ? `${id}-help` : undefined} className="font-mono text-xs" {...props} />
    {help && <p id={`${id}-help`} className="text-xs text-muted-foreground">{help}</p>}
  </div>
}

function Command({ title, command }) {
  return <div className="grid min-w-0 gap-2">
    <p className="text-xs font-medium">{title}</p>
    <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-3 text-[11px]" tabIndex={0} aria-label={title}>{command}</pre>
    <CopyCommand command={command} />
  </div>
}

export function GatewaySetup({ open, onOpenChange, context, onRefresh, initialGateway }) {
  const [stage, setStage] = React.useState(0)
  const [info, setInfo] = React.useState(null)
  const [infoError, setInfoError] = React.useState(null)
  const [snapshot, setSnapshot] = React.useState(context)
  const [path, setPath] = React.useState("existing")
  const [gateway, setGateway] = React.useState("")
  const [name, setName] = React.useState("")
  const [mode, setMode] = React.useState("kubernetes")
  const [endpoint, setEndpoint] = React.useState("")
  const [bundleDir, setBundleDir] = React.useState("")
  const [kubeContext, setKubeContext] = React.useState("")
  const [namespace, setNamespace] = React.useState("")
  const [service, setService] = React.useState("")
  const [servicePort, setServicePort] = React.useState("")
  const [localPort, setLocalPort] = React.useState("")
  const [result, setResult] = React.useState(null)
  const [workspace, setWorkspace] = React.useState("")
  const [busy, setBusy] = React.useState(null)
  const [error, setError] = React.useState(null)
  const request = React.useRef(0)
  const heading = React.useRef(null)
  const prefix = React.useId()
  const current = snapshot ?? context
  const gateways = current?.gateways ?? []

  React.useEffect(() => { setSnapshot(context) }, [context])
  React.useEffect(() => {
    if (!open) return
    let cancelled = false
    setStage(initialGateway ? 2 : 0)
    setPath(context?.gateways?.length ? "existing" : "new")
    setGateway(initialGateway || context?.gateways?.find((item) => item.name === context.gateway)?.name || context?.gateways?.[0]?.name || "")
    setResult(null); setWorkspace(""); setError(null); setBusy(null)
    setInfo(null); setInfoError(null)
    api.onboarding().then((value) => { if (!cancelled) setInfo(value) }).catch((error) => { if (!cancelled) setInfoError(error.message) })
    return () => { cancelled = true; request.current += 1 }
  }, [open, initialGateway]) // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => { if (open) heading.current?.focus() }, [stage, open])

  const plan = registrationPlan({ name, configDir: info?.configDir, bundleDir, mode, endpoint, kubeContext, namespace, service, servicePort, localPort, gateways })
  const checked = result?.gateway?.name === gateway ? result : null
  const selectedRegistration = gateways.find((item) => item.name === gateway)
  const pinnedMismatch = (current?.gatewayFixed && gateway !== current.gateway) || (current?.workspaceFixed && workspace !== current.workspace)
  const ready = Boolean(info && checked?.canConnect && checked.workspaces.some((item) => item.name === workspace) && !pinnedMismatch)

  function chooseGateway(value) {
    request.current += 1
    setGateway(value); setResult(null); setWorkspace(""); setError(null)
  }

  async function refresh() {
    const id = ++request.current
    setBusy("refresh"); setError(null)
    try {
      const next = await onRefresh()
      if (request.current !== id) return
      setSnapshot(next)
      setResult(null); setWorkspace("")
      if (path === "new" && next.gateways.some((item) => item.name === name)) setGateway(name)
      else if (!next.gateways.some((item) => item.name === gateway)) setGateway(next.gateways[0]?.name || "")
      try {
        const nextInfo = await api.onboarding()
        if (request.current === id) { setInfo(nextInfo); setInfoError(null) }
      } catch (error) { if (request.current === id) setInfoError(error.message) }
    } catch (error) { if (request.current === id) setError(error.message) }
    finally { if (request.current === id) setBusy(null) }
  }

  async function check() {
    const id = ++request.current
    setBusy("check"); setResult(null); setWorkspace(""); setError(null)
    try {
      const next = await api.checkGateway(gateway)
      if (request.current !== id) return
      setResult(next)
      const preferred = (current?.workspaceFixed || gateway === current?.gateway) ? current?.workspace : null
      setWorkspace(next.workspaces.find((item) => item.name === preferred)?.name || (current?.workspaceFixed ? "" : next.workspaces[0]?.name) || "")
    } catch (error) { if (request.current === id) setError(error.message) }
    finally { if (request.current === id) setBusy(null) }
  }

  async function activate() {
    if (!ready) return
    setBusy("activate"); setError(null)
    try {
      await api.selectContext({ gateway, workspace })
      window.location.reload()
    } catch (error) { setError(error.message); setBusy(null) }
  }

  function registrationPicker() {
    return <div className="grid gap-2">
      <Label htmlFor={`${prefix}-gateway`} className="text-xs">Registered gateway to check</Label>
      {gateways.length ? <SelectField id={`${prefix}-gateway`} value={gateway} onChange={(event) => chooseGateway(event.target.value)} disabled={Boolean(busy)} className="w-full text-xs">
        {gateways.map((item) => <option key={item.name} value={item.name}>{item.name}{item.error ? " (invalid registration)" : item.supported === false ? ` (${item.authMode} unsupported)` : ""}</option>)}
      </SelectField> : <p className="text-xs text-muted-foreground">No registered gateways yet. Follow the registration instructions, then refresh.</p>}
      {selectedRegistration && <p className="break-all font-mono text-xs">{selectedRegistration.endpoint}</p>}
      <Button type="button" variant="outline" size="sm" onClick={refresh} disabled={Boolean(busy)} className="justify-self-start">{busy === "refresh" ? "Refreshing…" : "Refresh registrations"}</Button>
    </div>
  }

  return <Dialog open={open} onOpenChange={(value) => { if (busy !== "activate") onOpenChange(value) }}>
    <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>Set up connection</DialogTitle>
        <DialogDescription>Connect this console to an existing OpenShell gateway and sandbox. Nothing is provisioned, installed or registered by this dialog.</DialogDescription>
      </DialogHeader>
      <ol aria-label="Setup stages" className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        {STAGES.map((label, index) => <li key={label} aria-current={stage === index ? "step" : undefined} className={stage === index ? "font-medium text-foreground" : "text-muted-foreground"}>{index + 1}. {label}</li>)}
      </ol>
      <h3 ref={heading} tabIndex={-1} className="text-sm font-medium outline-none">{stage + 1}. {STAGES[stage]}</h3>
      {current?.configured && <p className="rounded-md border p-3 text-xs text-muted-foreground">The console keeps using <span className="font-mono">{current.gateway}/{current.workspace}</span> while you inspect or check another registration. Only Use gateway changes the console connection.</p>}
      {infoError && <div role="alert" className="grid gap-2 text-xs text-destructive"><p>Could not inspect this console: {infoError}</p><Button variant="outline" size="sm" onClick={refresh} disabled={Boolean(busy)}>Retry setup inspection</Button></div>}

      {stage === 0 && <div className="grid gap-4 text-xs">
        <p>You or your gateway administrator must already have a gateway, a workspace and a sandbox. This flow does not create Kubernetes resources, expose the gateway publicly, install tools or execute commands for you. Docker is not required to connect.</p>
        <p>Run every command on the machine running the console server, as the same OS user. For Kubernetes, you need access to the private cluster and permission to port-forward the gateway service.</p>
        <div className="rounded-md border p-3">
          <p className="mb-2 font-medium">Local prerequisites</p>
          {info ? <ul className="grid gap-2">
            <li>Node.js ≥22.13 required. Server reports <span className="font-mono">{info.nodeVersion}</span> on {info.platform}.</li>
            {[["openshell", "OpenShell CLI 0.1.2 — registration and native SSH"], ["ssh", "OpenSSH — native SSH in your terminal"], ["kubectl", "kubectl — only for a Kubernetes tunnel"]].map(([key, label]) => <li key={key}>{label}: <strong>{info.tools[key]?.available ? "found" : "not found"}</strong>{info.tools[key]?.path && <span className="block break-all font-mono text-muted-foreground">{info.tools[key].path}</span>}</li>)}
          </ul> : <p role="status">{infoError ? "Inspection unavailable; retry above." : "Inspecting installed tools…"}</p>}
          <p className="mt-3 text-muted-foreground">Tool discovery reports paths, not verified versions. An existing mTLS registration can be checked and used in the browser without the OpenShell CLI or OpenSSH. The browser SDK terminal is not OpenSSH.</p>
        </div>
        <p><strong>Supported authentication: mTLS only.</strong> OIDC, edge authentication and plain HTTP are unsupported. Get the endpoint and the original ca.crt, tls.crt and tls.key bundle securely from your administrator. Never paste or upload certificates, keys or credentials into this browser.</p>
        {info && <dl className="grid gap-2 rounded-md border p-3">
          <div><dt className="font-medium">OpenShell registrations</dt><dd className="break-all font-mono">{info.configDir}/gateways/NAME/metadata.json and mtls/</dd></div>
          <div><dt className="font-medium">Saved console selection</dt><dd className="break-all font-mono">{info.contextFile}</dd></div>
          <div><dt className="font-medium">Console activity and policy state</dt><dd className="break-all font-mono">{info.stateDir}</dd></div>
        </dl>}
      </div>}

      {stage === 1 && <div className="grid gap-4 text-xs">
        <Label htmlFor={`${prefix}-path`}>Registration path</Label>
        <SelectField id={`${prefix}-path`} value={path} onChange={(event) => setPath(event.target.value)} className="w-full text-xs">
          <option value="existing">Use an existing registration</option>
          <option value="new">Register a private loopback / Kubernetes gateway</option>
        </SelectField>
        {path === "existing" ? <>
          {registrationPicker()}
          <p>These are registrations on the console server, not discovered cloud resources. Refreshing reads their metadata without selecting a gateway.</p>
          <p>For a non-loopback remote gateway, use your administrator’s existing OpenShell CLI registration workflow, then refresh here. Bare HTTPS registration uses unsupported edge authentication in OpenShell 0.1.2. Do not apply --local to a remote endpoint or invent an mTLS flag.</p>
        </> : <>
          <Field id={`${prefix}-name`} label="New registration name" value={name} onChange={setName} placeholder="private-cluster" autoComplete="off" help="Choose an unused local name. Commands refuse any existing registration directory, even a partial one; inspect it or choose another name rather than overwrite it." />
          <Label htmlFor={`${prefix}-mode`}>Private endpoint route</Label>
          <SelectField id={`${prefix}-mode`} value={mode} onChange={(event) => setMode(event.target.value)} className="w-full text-xs">
            <option value="kubernetes">Kubernetes service via a loopback tunnel</option>
            <option value="loopback">Existing HTTPS loopback endpoint</option>
          </SelectField>
          {mode === "kubernetes" ? <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field id={`${prefix}-kube-context`} label="Kubernetes context" value={kubeContext} onChange={setKubeContext} />
              <Field id={`${prefix}-namespace`} label="Namespace" value={namespace} onChange={setNamespace} />
              <Field id={`${prefix}-service`} label="Gateway service name" value={service} onChange={setService} />
              <Field id={`${prefix}-service-port`} label="Gateway service port" value={servicePort} onChange={setServicePort} inputMode="numeric" />
              <Field id={`${prefix}-local-port`} label="Local tunnel port" value={localPort} onChange={setLocalPort} inputMode="numeric" />
            </div>
            <p>The tunnel binds only to 127.0.0.1. It does not expose the gateway publicly. The TLS certificate must cover the loopback endpoint; ask the administrator if the connection check reports a hostname mismatch. Do not disable TLS verification.</p>
          </> : <Field id={`${prefix}-endpoint`} label="HTTPS loopback endpoint" value={endpoint} onChange={setEndpoint} placeholder="https://127.0.0.1:8443" autoComplete="off" help="Use the administrator’s existing local endpoint. No credentials, path, query or fragment. Keep any existing tunnel running." />}
          <Field id={`${prefix}-bundle`} label="Original administrator bundle directory (absolute local path)" value={bundleDir} onChange={setBundleDir} placeholder="/Users/you/private/gateway-bundle" autoComplete="off" help="Store the unchanged ca.crt, tls.crt and tls.key files here outside the registration directory, privately on the console server. Protect the directory with mode 700 and the files with mode 600. This is a path only, never certificate contents." />
          <p className="rounded-md border border-amber-500/40 p-3"><strong>OpenShell 0.1.2 behavior:</strong> gateway add --local was observed replacing preinstalled certificates. The reviewed script below installs your administrator’s bundle first, then restores that same original bundle after registration, including when the CLI fails. Keep the source bundle unchanged. --local describes the loopback endpoint, not where the sandbox compute runs.</p>
          <p>The CLI may report “Gateway is not reachable” before the original bundle is restored. Registration success is not proof of connectivity: use Check connection afterward, and resolve any remaining failure rather than disabling TLS.</p>
          {plan.errors.length ? <div className="rounded-md border p-3"><p className="mb-2 font-medium">Commands appear only when all required values are safe and complete.</p><ul className="list-disc space-y-1 pl-4">{plan.errors.map((message) => <li key={message}>{message}</li>)}</ul></div> : <>
            {plan.tunnelCommand && <><Command title="1. Run in a separate terminal and leave running" command={plan.tunnelCommand} /><p>Wait for kubectl to report “Forwarding from 127.0.0.1…”. Keep this tunnel running for checks, browser use and native SSH.</p></>}
            <p>Endpoint: <span className="break-all font-mono">{plan.endpoint}</span><br />Registration metadata: <span className="break-all font-mono">{plan.destination}/metadata.json</span><br />Credentials: <span className="break-all font-mono">{plan.destination}/mtls/&#123;ca.crt,tls.crt,tls.key&#125;</span></p>
            <Command title={`${plan.tunnelCommand ? "2" : "1"}. Review, copy and run manually in a POSIX shell on the console server`} command={plan.registrationCommand} />
            <p>This command creates a named local CLI registration and private certificate copies (directories 700, files 600). It does not provision infrastructure or activate the console. The CLI may change its own active gateway. No command runs when you copy it. If interrupted or unsuccessful, inspect the registration and original bundle before proceeding.</p>
          </>}
          {registrationPicker()}
        </>}
      </div>}

      {stage === 2 && <div className="grid gap-4 text-xs">
        {registrationPicker()}
        <p>Check connection reads this named registration and its existing mTLS files, validates TLS and lists real workspaces. It does not save a selection, change credentials or SSH configuration, execute anything in a sandbox, write console state or start collectors.</p>
        <p>Only HTTPS with mTLS is supported; OIDC, edge and plain HTTP are unsupported. Native SSH prerequisites are reported separately and do not block a browser connection.</p>
        <Button type="button" onClick={check} disabled={Boolean(busy) || !selectedRegistration} className="justify-self-start">{busy === "check" ? "Checking connection…" : "Check connection"}</Button>
        {checked && <div className="grid gap-4" aria-live="polite">
          <ul className="grid gap-2">{checked.checks.map((item) => <li key={item.id} className="rounded-md border p-3"><p className="font-medium">{item.status === "pass" ? "Pass" : item.status === "fail" ? "Failed" : "Warning"}: {item.label}</p><p className="mt-1 break-words text-muted-foreground">{item.detail}</p></li>)}</ul>
          <p>Native SSH: {checked.sshReady ? "prerequisites found; open the sandbox’s SSH command after activation." : "not ready. Install/configure OpenShell CLI 0.1.2 and OpenSSH on the console machine and your terminal host as needed; review the checks above."} Browser SDK terminal access is a separate connection path.</p>
          {checked.workspaces.length > 0 ? <>
            <Label htmlFor={`${prefix}-workspace`} className="text-xs">Workspace returned by this gateway</Label>
            <SelectField id={`${prefix}-workspace`} value={workspace} onChange={(event) => setWorkspace(event.target.value)} disabled={Boolean(busy)} className="w-full text-xs">
              {checked.workspaces.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
            </SelectField>
          </> : <p role="status">No workspace choices were returned. Fix any failed checks, verify workspace access with your administrator, then check again. No workspace will be invented or provisioned.</p>}
          {!checked.canConnect && <p role="alert" className="text-destructive">Connection is not ready. Follow the check details, leave any tunnel running, then run Check connection again.</p>}
        </div>}
      </div>}

      {stage === 3 && checked && <div className="grid gap-4 text-xs">
        <dl className="grid gap-2 rounded-md border p-3">
          <div><dt className="font-medium">Gateway</dt><dd className="break-all font-mono">{checked.gateway.name}</dd></div>
          <div><dt className="font-medium">Endpoint</dt><dd className="break-all font-mono">{checked.gateway.endpoint}</dd></div>
          <div><dt className="font-medium">Workspace</dt><dd className="break-all font-mono">{workspace}</dd></div>
          <div><dt className="font-medium">Authentication</dt><dd>{checked.gateway.authMode}</dd></div>
        </dl>
        <p><strong>Use gateway</strong> revalidates the gateway and workspace, saves this console selection{info?.contextFile && <> to <span className="break-all font-mono">{info.contextFile}</span></>}, and reloads the console. It does not rewrite gateway credentials or your SSH configuration.</p>
        <ul className="list-disc space-y-2 pl-4">
          <li>Activity collection starts for this selection and writes local console state{info?.stateDir && <> under <span className="break-all font-mono">{info.stateDir}</span></>}. Previously configured activity deliveries and service deadlines may resume.</li>
          <li>Saved or environment-pinned selections reconnect when the console restarts. A CLI-active suggestion alone does not connect a fresh console.</li>
          <li>Existing terminal sessions keep their original connection; switching the console does not move them.</li>
          <li>The organization policy sweeper is {info ? (info.policySweepEnabled ? "enabled by OPENSHELL_CONSOLE_SWEEP=1" : "disabled unless OPENSHELL_CONSOLE_SWEEP=1") : "opt-in via OPENSHELL_CONSOLE_SWEEP=1"} and stays scoped to the startup context.</li>
          <li>Legacy checkout policies may be copied once for the original loopback openshell/default registration only. Other registrations do not inherit them.</li>
        </ul>
        <div className="rounded-md border p-3"><p className="font-medium">Expected success</p><p className="mt-1">Keep any tunnel running. Find your existing sandbox and wait for Ready → choose SSH shell → Open SSH in terminal → run <code>hostname</code> and <code>pwd</code>. Verify that you reached the expected sandbox. You can also copy the command into your own terminal. Native SSH requires OpenShell CLI 0.1.2 and OpenSSH; the browser terminal is not OpenSSH.</p></div>
      </div>}
      {pinnedMismatch && stage >= 2 && <p role="alert" className="text-xs text-destructive">The console server environment pins {current?.gatewayFixed ? `gateway ${current.gateway}` : ""}{current?.gatewayFixed && current?.workspaceFixed ? " and " : ""}{current?.workspaceFixed ? `workspace ${current.workspace}` : ""}. You may inspect other registrations, but must change that environment and restart the server to activate this selection.</p>}
      {error && <p role="alert" className="break-words text-xs text-destructive">{error}</p>}
      <DialogFooter>
        <Button type="button" variant="ghost" disabled={Boolean(busy)} onClick={() => onOpenChange(false)}>Close</Button>
        {stage > 0 && <Button type="button" variant="outline" disabled={Boolean(busy)} onClick={() => { setStage(stage - 1); setError(null) }}>Back</Button>}
        {stage < 2 && <Button type="button" disabled={Boolean(busy)} onClick={() => { setStage(stage + 1); setError(null) }}>{stage === 0 ? "Registration options" : "Continue to connection check"}</Button>}
        {stage === 2 && <Button type="button" disabled={Boolean(busy) || !ready} onClick={() => setStage(3)}>Review connection</Button>}
        {stage === 3 && <Button type="button" disabled={Boolean(busy) || !ready} onClick={activate}>{busy === "activate" ? "Activating…" : "Use gateway"}</Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
