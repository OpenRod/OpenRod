// The services a secret can be for, as a person thinks of them: a logo, a
// name, what it's for, and where to get a key. Each maps 1:1 to one of
// NVIDIA's published provider profiles, which the console imports on demand.
export const SERVICE_GROUPS = [
  { id: "agent", label: "Agents" },
  { id: "inference", label: "Models" },
  { id: "code", label: "Code" },
]

export const SERVICES = [
  { id: "claude-code", name: "Claude Code", group: "agent", blurb: "Anthropic's coding agent", keyUrl: "https://console.anthropic.com/settings/keys", keyHint: "sk-ant-…" },
  { id: "codex", name: "Codex", group: "agent", blurb: "Existing Codex OAuth session", helpUrl: "https://developers.openai.com/codex/auth/" },
  { id: "copilot", name: "Copilot", group: "agent", blurb: "GitHub Copilot CLI" },
  { id: "openai", name: "OpenAI", group: "inference", blurb: "GPT models API", keyUrl: "https://platform.openai.com/api-keys", keyHint: "sk-…" },
  { id: "openrouter", name: "OpenRouter", group: "inference", blurb: "One key, many models", keyUrl: "https://openrouter.ai/keys", keyHint: "sk-or-…" },
  { id: "github", name: "GitHub", group: "code", blurb: "Repos and API", keyUrl: "https://github.com/settings/personal-access-tokens", keyHint: "github_pat_…" },
]

export const serviceOf = (type) => SERVICES.find((s) => s.id === type) ?? null
export const logoOf = (type) => (serviceOf(type) ? `/logos/${type}.svg` : null)

const AUTH = {
  header: (c) => `in the ${c.headerName ?? "custom"} header`,
  bearer: () => "as a Bearer token",
  basic: () => "as basic auth",
  query: (c) => `as ?${c.queryParam ?? "…"}`,
  path: () => "in the request path",
}
export const injectionOf = (c) => (AUTH[c.authStyle] ?? (() => "by the proxy"))(c)
export const programsOf = (profile) => [...new Set((profile?.binaries ?? []).map((b) => b.split("/").pop()))]
