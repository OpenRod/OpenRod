import * as React from "react"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import "@xterm/xterm/css/xterm.css"
import { ChevronDown, RotateCcw, Terminal as TerminalIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { api } from "@/lib/api"
import { defaultSession, sessionChoices, sessionName, terminalHref } from "@/lib/sandbox-session"

// The terminal itself is always dark, whatever the console's theme.
const BACKGROUND = "#0b0e14"
const THEME = {
  background: BACKGROUND, foreground: "#d6dde6", cursor: "#d6dde6", cursorAccent: BACKGROUND, selectionBackground: "#2b3a4d",
  black: "#0b0e14", red: "#f47067", green: "#57ab5a", yellow: "#c69026", blue: "#539bf5", magenta: "#b083f0", cyan: "#39c5cf", white: "#adbac7",
  brightBlack: "#636e7b", brightRed: "#ff938a", brightGreen: "#6bc46d", brightYellow: "#daaa3f", brightBlue: "#6cb6ff", brightMagenta: "#dcbdfb", brightCyan: "#56d4dd", brightWhite: "#cdd9e5",
}
const STATUS = {
  connecting: { dot: "bg-amber-500", text: "Connecting…" },
  live: { dot: "bg-emerald-500", text: "Live" },
  ended: { dot: "bg-muted-foreground", text: "Ended" },
  failed: { dot: "bg-red-500", text: "Failed" },
}

// One browser tab, one session. The page asks the console for a ticket, then
// streams keystrokes and output over a WebSocket; closing the tab ends the
// session, like closing a terminal window.
export function TerminalView({ name, session: requested, setupLogin, mcp }) {
  const [sandbox, setSandbox] = React.useState(null)
  const [loadError, setLoadError] = React.useState(null)
  const [state, setState] = React.useState({ status: "connecting" })
  const [attempt, setAttempt] = React.useState(0)
  const holder = React.useRef(null)
  const session = requested ?? (sandbox ? defaultSession(sandbox) : null)

  React.useEffect(() => {
    let current = true
    api.sandbox(name).then((record) => { if (current) setSandbox(record) }).catch((error) => { if (current) setLoadError(error.message) })
    return () => { current = false }
  }, [name])
  React.useEffect(() => {
    const previous = document.title
    document.title = `${name} · ${session ? sessionName(session) : "Terminal"}`
    return () => { document.title = previous }
  }, [name, session])

  React.useEffect(() => {
    const element = holder.current
    if (!session || !element) return undefined
    const term = new Terminal({
      cursorBlink: true, fontSize: 13, lineHeight: 1.2, scrollback: 10000, theme: THEME,
      fontFamily: 'Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(element)
    fit.fit()
    term.focus()
    let socket = null
    let closed = false
    const open = () => socket?.readyState === WebSocket.OPEN
    const encoder = new TextEncoder()
    term.onData((data) => { if (open()) socket.send(encoder.encode(data)) })
    term.onBinary((data) => { if (open()) socket.send(Uint8Array.from(data, (c) => c.charCodeAt(0))) })
    term.onResize(({ cols, rows }) => { if (open()) socket.send(JSON.stringify({ type: "resize", cols, rows })) })
    const observer = new ResizeObserver(() => fit.fit())
    observer.observe(element)
    // The monospace font may arrive after the first measurement.
    document.fonts?.ready.then(() => { if (!closed) fit.fit() })
    const note = (text) => term.write(`\r\n\x1b[2m${text}\x1b[0m\r\n`)
    setState({ status: "connecting" })
    ;(async () => {
      try {
        const { ticket } = await api.terminalSession(name, { session, setupLogin, mcp, cols: term.cols, rows: term.rows })
        if (closed) return
        const scheme = window.location.protocol === "https:" ? "wss" : "ws"
        socket = new WebSocket(`${scheme}://${window.location.host}/api/os/terminal?ticket=${encodeURIComponent(ticket)}`)
        socket.binaryType = "arraybuffer"
        // A socket from a finished attempt must not touch the next one's state.
        socket.onopen = () => { if (closed) return; setState({ status: "live" }); socket.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows })) }
        socket.onmessage = (event) => {
          if (closed) return
          if (typeof event.data !== "string") { term.write(new Uint8Array(event.data)); return }
          let message
          try { message = JSON.parse(event.data) } catch { return }
          if (message.type === "exit") { setState({ status: "ended", exitCode: message.exitCode }); note(`Session ended with exit code ${message.exitCode}.`) }
          else if (message.type === "error") { setState({ status: "failed", message: message.message }); note(message.message) }
        }
        socket.onclose = () => { if (!closed) setState((s) => (s.status === "ended" || s.status === "failed" ? s : { status: "failed", message: "The connection closed." })) }
      } catch (error) {
        if (closed) return
        setState({ status: "failed", message: error.message })
        note(error.message)
      }
    })()
    return () => { closed = true; observer.disconnect(); socket?.close(); term.dispose() }
  }, [name, session, attempt, setupLogin, mcp])

  const status = STATUS[state.status]
  const choices = sandbox ? sessionChoices(sandbox) : []
  const over = state.status === "ended" || state.status === "failed"
  return (
    <div className="flex h-svh flex-col" style={{ background: BACKGROUND }}>
      {setupLogin && <div className="border-b border-border bg-card px-4 py-3 text-xs text-foreground">Connect this MCP with Codex. Open the authorization link it prints, complete sign-in, and paste the callback URL here when prompted. No inbound port is opened.</div>}
      <header className="flex h-11 shrink-0 items-center gap-2.5 border-b border-border bg-card px-3 text-xs">
        <TerminalIcon className="size-4 text-muted-foreground" aria-hidden="true" />
        <span className="font-medium">{name}</span>
        {session && <span className="text-muted-foreground">{sessionName(session)}</span>}
        <span className="flex min-w-0 items-center gap-1.5 truncate text-muted-foreground" role="status">
          <span className={`size-1.5 shrink-0 rounded-full ${status.dot}`} aria-hidden="true" />
          {state.status === "ended" ? `Ended · exit ${state.exitCode}` : state.status === "failed" ? state.message ?? status.text : status.text}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {over && (
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setAttempt((n) => n + 1)}>
              <RotateCcw className="size-3.5" aria-hidden="true" />Start again
            </Button>
          )}
          {choices.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="outline" size="sm" className="h-7 text-xs" />}>
                New session<ChevronDown className="size-3 opacity-70" aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                {choices.map((choice) => (
                  <DropdownMenuItem key={choice.id} render={<a href={terminalHref(name, choice.id)} target="_blank" rel="noreferrer" />}>
                    {choice.name}<span className="ml-auto text-[11px] text-muted-foreground">new tab</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </header>
      {loadError && !session
        ? <p role="alert" className="p-6 text-sm text-red-400">{loadError}</p>
        : <div ref={holder} className="min-h-0 flex-1 p-2 [&_.xterm]:h-full" />}
    </div>
  )
}
