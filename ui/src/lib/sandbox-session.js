import { currentComputeTarget } from './compute-target.js'
import { AGENTS } from "./image-templates.js"
import { agentsOf } from "./agents.js"

export const SESSION_LABEL = "openshell.console/session"
// The folder under /sandbox that a started-from-files sandbox opens in. The
// label is read back from the gateway, so its value is checked again here:
// one path segment of letters, digits, '-', '_' and '.', never "." or "..".
export const PROJECT_LABEL = "openshell.console/project"
export const persistentGateway = target => Boolean(target?.remote && /^console-ssh-[a-f0-9]{24}$/.test(target.name ?? target.gateway ?? ''))
export const projectOf = (sandbox) => {
  const value = sandbox?.labels?.[PROJECT_LABEL]
  return typeof value === "string" && /^[A-Za-z0-9]([A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$/.test(value) ? value : null
}

// What each session runs when someone connects: a login shell, or an agent by
// its own command. Labels come from the gateway, so only these ever run.
const SESSIONS = { shell: "/bin/bash -l", ...Object.fromEntries(AGENTS.map((a) => [a.command, a.command])) }
export const isSession = (session) => Object.hasOwn(SESSIONS, session ?? "")

// A launch may select only Shell or a session explicitly included by the template.
export function templateSession(saved, requested) {
  const start = saved.recipe.command.trim()
  const fallback = !start ? 'shell' : start !== 'shell' && isSession(start) ? start : null
  if (requested == null) return fallback
  const installed = saved.managed && saved.recipe.source === 'build'
    ? AGENTS.filter((agent) => saved.recipe.agents.includes(agent.id)).map((agent) => agent.command) : []
  if (requested !== 'shell' && requested !== fallback && !installed.includes(requested)) throw new Error('Choose Shell or an agent included in this template.')
  if (!isSession(requested)) throw new Error('Unknown session type.')
  return requested
}

export function sessionLaunch(session, command) {
  if (isSession(session)) {
    return {
      command: ["/bin/sleep", "infinity"],
      tty: false,
      labels: { [SESSION_LABEL]: session, ...(session !== "shell" ? { "openshell.console/agents": session } : {}) },
    }
  }
  return { command, tty: command.length > 0, labels: {} }
}

const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`

// Both copied commands and native launches own a private config directory.
// The shell must stay alive while ssh runs so its exit trap removes the config.
export function nativeSshCommand({ alias, ssh = "ssh", directory, configCommand, configHome, remoteArgv }) {
  const script = [
    "umask 077",
    ...(configHome ? [`export XDG_CONFIG_HOME=${shellQuote(configHome)}`] : []),
    directory ? `dir=${shellQuote(directory)}` : 'dir=$(mktemp -d "${TMPDIR:-/tmp}/openshell-ssh.XXXXXXXX") || exit',
    'trap \'rm -f -- "$dir/config"; rmdir -- "$dir"\' 0',
    "trap 'exit 129' HUP",
    "trap 'exit 130' INT",
    "trap 'exit 143' TERM",
    ...(configCommand ? [`${configCommand} > "$dir/config" || exit`] : []),
    `${shellQuote(ssh)} ${remoteArgv ? '-t ' : ''}-F "$dir/config" ${shellQuote(alias)}${remoteArgv ? ' ' + shellQuote(remoteArgv.map(shellQuote).join(' ')) : ''}`,
  ].join("; ")
  return `sh -c ${shellQuote(script)}`
}

// Every mode is pinned to the displayed gateway and workspace. Direct SSH
// opens a login shell; exec starts a new console session; attach uses its TTY.
export function connectionPlan(sandbox, { gateway, workspace = sandbox.workspace || "default", mode = "exec", executable = "openshell", ssh = "ssh", configHome, remote = false } = {}) {
  if (!["ssh", "exec", "attach"].includes(mode)) throw new Error("Unknown connection mode.")
  if (mode === "attach" && !sandbox.tty) throw new Error("This sandbox has no canonical TTY session.")
  const argv = ["--gateway", gateway, "--workspace", workspace, "sandbox"]
  if (mode === "ssh") {
    argv.push("ssh-config", sandbox.name)
    const alias = `openshell-${sandbox.name}.${workspace}`
    return {
      mode,
      alias,
      command: nativeSshCommand({ alias, ssh, configHome, remoteArgv: remote ? persistentSessionArgv('shell') : null, configCommand: [executable, ...argv].map(shellQuote).join(" ") }),
      session: null,
      workdir: null,
    }
  }
  if (mode === "attach") argv.push("connect", sandbox.name)
  else {
    const project = projectOf(sandbox)
    argv.push("exec", "--name", sandbox.name)
    if (project) argv.push("--workdir", `/sandbox/${project}`)
    argv.push("--tty", "--", ...(remote ? persistentSessionArgv(defaultSession(sandbox)) : sessionArgv(defaultSession(sandbox))))
  }
  return {
    mode,
    argv,
    command: `${configHome ? `env ${shellQuote(`XDG_CONFIG_HOME=${configHome}`)} ` : ""}${[executable, ...argv].map(shellQuote).join(" ")}`,
    session: mode === "exec" ? defaultSession(sandbox) : null,
    workdir: mode === "exec" && projectOf(sandbox) ? `/sandbox/${projectOf(sandbox)}` : null,
  }
}

// The browser terminal runs the same programs. What a tab opens by default is
// the session the sandbox was created for, or a shell for sandboxes started
// with their own command.
export const sessionArgv = (session) => (isSession(session) ? SESSIONS[session].split(" ") : null)
// Each program has one named, reattachable remote terminal. Cancelling an
// exec kills only the tmux client; the server owns the agent and its PTY.
export function persistentSessionArgv(session) {
  if (!isSession(session)) throw new Error('Unknown session type.')
  const script = `command -v tmux >/dev/null 2>&1 || { printf '%s\\n' 'This image needs tmux for sleep-safe terminals. Rebuild it with the console or add tmux to the image.' >&2; exit 127; }; exec tmux -L openshell-console new-session -A -s ${shellQuote('console-' + session)} ${sessionArgv(session).map(shellQuote).join(' ')}`
  return ['/bin/sh', '-c', script]
}
export function persistentTerminalPolicy(policy) {
  return { ...policy, filesystem: { ...policy.filesystem,
    // tmux allocates its own PTYs, unlike an SDK exec receiving one from the
    // supervisor. Keep these device grants explicit and remote-only.
    readWrite: [...new Set([...(policy.filesystem?.readWrite ?? []), '/dev/ptmx', '/dev/pts'])],
  } }
}
export const defaultSession = (sandbox) => (isSession(sandbox?.labels?.[SESSION_LABEL]) ? sandbox.labels[SESSION_LABEL] : "shell")
export const sessionName = (session) => (session === "shell" ? "Shell" : AGENTS.find((a) => a.command === session)?.name ?? session)
// A shell, plus every installed agent the console knows how to launch.
export function sessionChoices(sandbox) {
  const current = defaultSession(sandbox)
  const installed = agentsOf(sandbox).flatMap((agent) => AGENTS.filter((a) => a.name === agent.name).map((a) => a.command))
  const commands = [...new Set([...(current === "shell" ? [] : [current]), ...installed])]
  return [{ id: "shell", name: "Shell" }, ...commands.map((command) => ({ id: command, name: sessionName(command) }))]
}
// Pin a new terminal tab to its originating gateway/workspace, not whichever
// context another console tab happens to select later.
export function terminalHref(name, session, context, target = typeof context === "string" ? context : context?.target ?? currentComputeTarget()) {
  const query = new URLSearchParams()
  if (session) query.set("session", session)
  const gateway = typeof context?.gateway === "string" ? context.gateway : context?.gateway?.name ?? context?.name
  const workspace = context?.workspace ?? context?.gateway?.workspace
  if (gateway && workspace) {
    query.set("gateway", gateway)
    query.set("workspace", workspace)
    if (context?.remote) query.set('remote', '1')
  }
  const suffix = query.toString()
  return `?target=${target}#terminal/${encodeURIComponent(name)}${suffix ? `?${suffix}` : ""}`
}
