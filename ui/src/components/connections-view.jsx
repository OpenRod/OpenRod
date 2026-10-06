import * as React from "react"
import { Ellipsis, Plus, RefreshCw, Server, SquarePlus } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { BlurFade } from "@/components/ui/blur-fade"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { AddSshDialog } from "@/components/add-ssh-dialog"
import { ServerArt } from "@/components/location-step"
import { RemoteConnect } from "@/components/remote-connect"
import { api } from "@/lib/api"
import { useInventory } from "@/lib/inventory"
import { cn } from "@/lib/utils"

const STATE = {
  connected: { label: "Connected", dot: "bg-emerald-500" },
  connecting: { label: "Connecting…", dot: "bg-amber-400" },
  failed: { label: "Connection failed", dot: "bg-red-500" },
  off: { label: "Not connected", dot: "bg-stone-400 dark:bg-stone-500" },
}
const stateOf = (status) => STATE[status] ? status : "off"
const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`

function StatusLine({ row, count }) {
  const state = STATE[row.state]
  return <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
    <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", state.dot, row.state === "connecting" && "motion-safe:animate-pulse")} />
    <span>{state.label}</span>
    {row.state === "connected" && <span className="hidden sm:inline">· {plural(count, "sandbox", "sandboxes")}</span>}
  </span>
}

function HostRow({ row, count, working, onToggle, onCreate, menu }) {
  const connected = row.state === "connected"
  const title = row.label ?? row.name
  const detail = row.address
  return <li className="px-4 py-2 sm:px-5">
    <div className="flex items-center gap-3.5">
      <span className="flex h-[18px] w-8 shrink-0 items-center justify-center">
        {working || row.state === "connecting" ? <Spinner aria-label="Working" className="size-3.5" /> : <Switch checked={connected} aria-label={`${connected ? "Disconnect from" : "Connect to"} ${title}`} onCheckedChange={(next) => onToggle(row, next)} />}
      </span>
      <span aria-hidden="true" className={cn("flex w-6 shrink-0 justify-center transition-opacity duration-300 [&_svg]:block [&_svg]:h-[22px]", !connected && "opacity-50")}><ServerArt live={connected} /></span>
      <span className="flex min-w-0 flex-1 items-baseline gap-2.5">
        <span className="truncate text-[13px] font-medium">{title}</span>
        {detail && <span className="hidden min-w-0 truncate font-mono text-[11px] text-muted-foreground md:block">{detail}</span>}
      </span>
      <StatusLine row={row} count={count} />
      <span className="flex w-[60px] shrink-0 items-center justify-end gap-0.5">
        {connected && onCreate && <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`New sandbox on ${title}`} onClick={onCreate} className="size-7 text-muted-foreground hover:text-foreground" />}><SquarePlus className="size-4" /></TooltipTrigger>
          <TooltipContent>New sandbox</TooltipContent>
        </Tooltip>}
        {menu}
      </span>
    </div>
    {row.state === "failed" && row.error && <p className="mt-1 truncate pl-[46px] font-mono text-[11px] text-destructive" title={row.error}>{row.error}</p>}
  </li>
}

// SSH machines used as sandbox locations. One is connected at a time, so
// turning another on replaces the current one.
export function ConnectionsView({ onCreateSandbox }) {
  const inventory = useInventory()
  const [overview, setOverview] = React.useState(null)
  const [error, setError] = React.useState(null)
  const [working, setWorking] = React.useState(null)
  const [wizard, setWizard] = React.useState(null)
  const [adding, setAdding] = React.useState(false)
  const [confirming, setConfirming] = React.useState(null)

  const load = React.useCallback(async (signal) => {
    try { setOverview(await api.connections(signal)); setError(null) } catch (reason) { if (reason.name !== "AbortError") setError(reason.message) }
  }, [])
  React.useEffect(() => {
    const controller = new AbortController()
    load(controller.signal)
    return () => controller.abort()
  }, [load])

  const remote = overview?.active ?? null
  const remoteState = stateOf(remote?.status)
  const connected = remoteState === "connected"

  const rows = React.useMemo(() => {
    if (!overview) return []
    const list = overview.hosts.map((host) => ({ ...host, state: remote?.host === host.name ? stateOf(remote.status) : "off", error: remote?.host === host.name ? remote.error : null }))
    if (remote && !list.some((row) => row.name === remote.host)) list.push({ name: remote.host, state: remoteState, error: remote.error })
    return list
  }, [overview, remote, remoteState])
  const mine = rows.filter((row) => row.managed || row.name === remote?.host).sort((a, b) => (b.state === "connected") - (a.state === "connected") || (a.label ?? a.name).localeCompare(b.label ?? b.name))
  const fromConfig = rows.filter((row) => !mine.includes(row))
  const countFor = (row) => inventory.sandboxes.filter((sandbox) => sandbox.location?.remote && sandbox.location.host === row.name).length

  async function act(name, operation, failure) {
    setWorking(name)
    try { await operation(); await load(); inventory.refresh() } catch (reason) { toast.error(failure, { description: reason.message }) } finally { setWorking(null) }
  }
  const toggle = (row, next) => {
    if (next) setWizard({ host: row.name, replacing: connected ? remote.host : undefined })
    else act(row.name, async () => { await api.disconnectRemote(); toast.success(`Disconnected from ${row.label ?? row.name}`) }, "Couldn’t disconnect")
  }
  function confirmed() {
    const { kind, row } = confirming
    setConfirming(null)
    const title = row.label ?? row.name
    if (kind === "forget") act(row.name, async () => { await api.forgetRemote(); toast.success(`Forgot ${title}`) }, "Couldn’t forget it")
    else act(row.name, async () => {
      // Forget can move the console off this host, which outdates the page's
      // context for the next request, so it runs last.
      await api.removeSshHost(row.name)
      if (remote?.host === row.name) await api.forgetRemote()
      toast.success(`Deleted ${title}`)
    }, "Couldn’t delete it")
  }

  function menuFor(row) {
    const remembered = row.name === remote?.host
    if (!row.managed && !remembered) return null
    return <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`More actions for ${row.label ?? row.name}`} className="size-7 text-muted-foreground hover:text-foreground" />}><Ellipsis className="size-4" /></DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        {row.state === "connected" && <DropdownMenuItem onClick={() => toggle(row, false)}>Disconnect</DropdownMenuItem>}
        {row.state !== "connected" && row.state !== "connecting" && <DropdownMenuItem onClick={() => toggle(row, true)}>{row.state === "failed" ? "Try again" : "Connect"}</DropdownMenuItem>}
        {remembered && !row.managed && <DropdownMenuItem onClick={() => setConfirming({ kind: "forget", row })}>Forget</DropdownMenuItem>}
        {row.managed && <>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" disabled={row.state === "connected" || row.state === "connecting"} onClick={() => setConfirming({ kind: "delete", row })}>Delete{row.state === "connected" ? " (disconnect first)" : ""}</DropdownMenuItem>
        </>}
      </DropdownMenuContent>
    </DropdownMenu>
  }
  const renderRow = (row, index) => <BlurFade key={row.name} delay={0.04 * index} offset={4} blur="3px" className="contents">
    <HostRow row={row} count={countFor(row)} working={working === row.name} onToggle={toggle} onCreate={onCreateSandbox} menu={menuFor(row)} />
  </BlurFade>

  const confirmTitle = confirming?.row.label ?? confirming?.row.name
  const list = "divide-y divide-border/60 overflow-hidden rounded-xl border border-border/80 bg-card"
  return <>
    <div className="h-[calc(100svh-3.5rem)] overflow-y-auto">
      <div className="grid gap-8 px-4 py-5 sm:px-6">
        {error && <div role="alert" className="flex items-center gap-3 text-xs text-red-600"><span>{error}</span><Button variant="outline" size="sm" onClick={() => load()}>Retry</Button></div>}
        {!overview && !error && <p role="status" className="py-20 text-center text-sm text-muted-foreground">Reading connections…</p>}
        {overview && <>
          <section aria-label="SSH connections" className="grid gap-4">
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <h2 className="text-sm font-medium">SSH connections</h2>
                <p className="mt-0.5 text-xs text-muted-foreground">Added in OpenRod. One machine is connected at a time.</p>
              </div>
              <Button variant="ghost" size="icon-sm" aria-label="Refresh connections" onClick={() => load()} className="text-muted-foreground"><RefreshCw /></Button>
              <Button size="sm" onClick={() => setAdding(true)} className="bg-[var(--action)] text-[var(--action-foreground)] hover:bg-[var(--action)]/90"><Plus className="size-3.5" />Add</Button>
            </div>
            {mine.length > 0
              ? <ul className={list}>{mine.map(renderRow)}</ul>
              : <div className="rounded-xl border border-border bg-card py-14 text-center">
                <Server className="mx-auto mb-3 size-6 text-muted-foreground" strokeWidth={1.5} />
                <p className="text-sm">No saved connections</p>
                <p className="mx-auto mt-1 max-w-xs text-xs text-muted-foreground">Add a server to run sandboxes on your own machine over SSH. You confirm its host key before anything is saved.</p>
                <Button variant="outline" className="mt-4" onClick={() => setAdding(true)}>Add connection</Button>
              </div>}
          </section>
          {fromConfig.length > 0 && <section aria-label="Hosts in your SSH config" className="grid gap-4">
            <div>
              <h2 className="text-sm font-medium">From your SSH config</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">Found in <span className="font-mono">~/.ssh/config</span>. OpenRod reads these and never edits them.</p>
            </div>
            <ul className={list}>{fromConfig.map(renderRow)}</ul>
          </section>}
        </>}
      </div>
    </div>

    <AlertDialog open={Boolean(confirming)} onOpenChange={(open) => { if (!open) setConfirming(null) }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{confirming?.kind === "forget" ? "Forget" : "Delete"} {confirmTitle}?</AlertDialogTitle>
          <AlertDialogDescription>
            {confirming?.kind === "forget"
              ? `${confirming?.row.state === "connected" ? "This disconnects from the machine and removes it from this page. " : "This removes it from this page. "}Sandboxes on the machine keep running, and the host stays in your SSH configuration, so you can connect again later.`
              : "This removes the saved connection and its trusted host keys from OpenRod. Sandboxes on the machine keep running. You can add it again later."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={confirmed}>{confirming?.kind === "forget" ? "Forget" : "Delete"}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <AddSshDialog open={adding} onOpenChange={setAdding} onAdded={(saved) => { setAdding(false); toast.success(`Added ${saved.name}`); load(); setWizard({ host: saved.alias }) }} />

    <Dialog open={Boolean(wizard)} onOpenChange={(open) => { if (!open) setWizard(null) }}>
      <DialogContent className="sm:max-w-3xl" aria-describedby={undefined}>
        <DialogHeader><DialogTitle>{wizard?.replacing ? "Switch host" : "Connect a remote machine"}</DialogTitle></DialogHeader>
        {wizard && <RemoteConnect initialHost={wizard.host} connectedHost={wizard.replacing ?? null} onUseConnected={() => setWizard(null)}
          onConnected={(job) => { setWizard(null); toast.success(`Connected to ${job.host}`); load(); inventory.refresh() }} onBack={() => setWizard(null)} />}
      </DialogContent>
    </Dialog>
  </>
}
