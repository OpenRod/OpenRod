const AGENTS = [
  { name: "Claude Code", logo: "claudecode", commands: ["claude", "claude-code"] },
  { name: "Codex", logo: "codex", commands: ["codex"] },
  { name: "GitHub Copilot", logo: "copilot", commands: ["copilot"] },
  { name: "Cursor", logo: "cursor", commands: ["cursor-agent"] },
  { name: "Gemini CLI", logo: "gemini", commands: ["gemini"] },
  { name: "OpenCode", logo: "opencode", commands: ["opencode"] },
  { name: "OpenClaw", logo: "openclaw-color", commands: ["openclaw"] },
  { name: "Pi", logo: "pi", commands: ["pi"] },
]

// Explicit labels can list multiple agent types, separated by commas or
// newlines. Fall back only to a recognized launch executable, never providers
// or arbitrary command arguments. These identify configured types, not liveness.
export function agentsOf(sandbox) {
  const labels = sandbox?.labels ?? {}
  const metadata = labels["openshell.console/agents"] || labels["openshell.console/agent"]
  const names = typeof metadata === "string" ? metadata.split(/[,\n]/).map((name) => name.trim()).filter(Boolean) : []
  const executable = Array.isArray(sandbox?.command) ? sandbox.command[0]?.split("/").pop() : null
  const explicit = names.length > 0
  const values = explicit ? names : executable ? [executable] : []
  const agents = values.flatMap((value) => {
    const known = AGENTS.find((agent) => agent.name.toLowerCase() === value.toLowerCase() || agent.commands.includes(value.toLowerCase()))
    if (known) return [{ name: known.name, logo: `/logos/agents/${known.logo}.svg` }]
    return explicit ? [{ name: value, logo: null }] : []
  })
  return agents.filter((agent, index) => agents.findIndex((item) => item.name.toLowerCase() === agent.name.toLowerCase()) === index)
}
