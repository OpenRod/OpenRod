export const SESSION_LABEL = "openshell.console/session"

export function sessionLaunch(session, command) {
  if (session === "claude" || session === "shell") {
    return {
      command: ["/bin/sleep", "infinity"],
      tty: false,
      labels: { [SESSION_LABEL]: session, ...(session === "claude" ? { "openshell.console/agents": "claude" } : {}) },
    }
  }
  return { command, tty: command.length > 0, labels: {} }
}

export function sessionCommand(sandbox) {
  const session = sandbox.labels?.[SESSION_LABEL]
  // Sandbox names are validated by the server; quote defensively for copied commands.
  const name = `'${sandbox.name.replaceAll("'", "'\\''")}'`
  if (session === "claude" || session === "shell") {
    return `openshell sandbox exec --name ${name} --tty -- ${session === "claude" ? "claude" : "/bin/bash -l"}`
  }
  return `openshell sandbox connect ${name}`
}
