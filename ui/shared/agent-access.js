// Built-in agent requirements, composed automatically when launching a built template.
// Image recipes declare agent IDs; they cannot supply arbitrary network permissions.
const endpoint = (host, access = 'read-write') => ({ host, ports: [443], protocol: 'rest', access, enforcement: 'enforce' })
// Script-based CLIs use their interpreter as the kernel executable identity.
// These rules consequently also cover other code run by that interpreter, but
// only to the listed destinations. Never substitute an all-hosts allow rule.
const node = ['/usr/local/bin/node', '/usr/bin/node']
const google = ['generativelanguage.googleapis.com', 'cloudcode-pa.googleapis.com', 'oauth2.googleapis.com', 'accounts.google.com', 'www.googleapis.com', 'aiplatform.googleapis.com', '*.aiplatform.googleapis.com']
const codeAssistHosts = new Set(['cloudcode-pa.googleapis.com', 'daily-cloudcode-pa.googleapis.com', 'daily-cloudcode-pa.sandbox.googleapis.com'])
// These RPCs retrieve arbitrary websites through Google's backend, outside
// sandbox destination enforcement. The installed CLI's search_web uses the
// non-streaming generateContent RPC; normal chat uses streamGenerateContent.
// This blocks those built-in tools, not grounding in arbitrary model bodies.
const antigravityEndpoint = (host) => ({
  ...endpoint(host),
  ...(codeAssistHosts.has(host) ? { deny: ['fetchFromTrawlerCache', 'rewriteUri', 'generateContent'].map(rpc => ({ method: '*', path: `/**:${rpc}*` })) } : {}),
})
const modelProviders = ['api.anthropic.com', 'api.openai.com', 'openrouter.ai', 'api.groq.com', 'api.deepseek.com', 'api.mistral.ai', 'api.x.ai', 'generativelanguage.googleapis.com']
const profile = (name, binaries, hosts) => ({ name, binaries, endpoints: [...new Set(hosts)].map(host => endpoint(host)) })
// Sources: Gemini CLI code_assist/server.ts and oauth2.ts; NVIDIA provider
// profiles; kiro.dev/docs/privacy-and-security/firewalls/;
// cursor.com/docs/enterprise/network-configuration;
// docs.factory.ai/enterprise/network-and-deployment.
export const AGENT_ACCESS = {
  claude: {
    name: 'Claude Code',
    binaries: ['/usr/bin/claude', '/usr/local/bin/claude'],
    endpoints: ['api.anthropic.com', 'platform.claude.com', 'claude.ai'].map(host => endpoint(host)),
    authentication: 'Attach a Claude credential or sign in with your subscription after connecting.',
    // Claude Code lists claude.ai connectors on api.anthropic.com and calls
    // them through Anthropic's proxy, which holds each connector's sign-in.
    connectors: { name: 'claude.ai connectors', hosts: ['mcp-proxy.anthropic.com'] },
  },
  opencode: {
    name: 'OpenCode',
    // The npm launcher executes this native binary (verified in the built image).
    binaries: ['/usr/local/lib/node_modules/opencode-ai/bin/opencode.exe', '/usr/local/bin/opencode', '/sandbox/.opencode/bin/opencode'],
    endpoints: [endpoint('models.opencode.ai', 'read-only'), endpoint('models.dev', 'read-only'), endpoint('opencode.ai'), ...modelProviders.map(host => endpoint(host))],
    authentication: 'Includes connections for OpenCode’s hosted models. Use /connect for models that require an account. Other model providers need their own network rules and credentials.',
  },
  codex: {
    name: 'Codex',
    binaries: ['/usr/bin/codex', '/usr/local/bin/codex', '/usr/local/lib/node_modules/@openai/**/codex', '/usr/lib/node_modules/@openai/**/codex'],
    endpoints: ['api.openai.com', 'auth.openai.com', 'chatgpt.com', 'ab.chatgpt.com'].map(host => endpoint(host)),
    // Codex lists and calls ChatGPT connectors (apps) on chatgpt.com, which it
    // also needs for sign-in, so turning them off closes these paths instead.
    connectors: { name: 'ChatGPT connectors', paths: { 'chatgpt.com': ['/backend-api/ps/mcp', '/backend-api/ps/mcp/**', '/backend-api/connectors/**'] } },
    // Codex's "Sign in with ChatGPT" redirects the host browser to a callback
    // server inside the sandbox, which the browser cannot reach.
    authentication: 'Attach a Codex credential, or run codex after connecting and choose “Sign in with Device Code” (ChatGPT plan) or “Provide your own API key”. “Sign in with ChatGPT” can’t complete from a sandbox.',
  },
  gemini: profile('Gemini CLI', [...node, '/usr/local/bin/gemini'], google),
  // Hosts for Pi's built-in /login flows (pi-ai dist/auth/oauth/*.js).
  pi: {
    ...profile('Pi', [...node, '/usr/local/bin/pi'], [...modelProviders, ...google, 'platform.claude.com', 'claude.ai', 'auth.openai.com', 'chatgpt.com', 'github.com', 'api.github.com', 'api.githubcopilot.com', '*.githubcopilot.com', 'auth.x.ai', 'auth.kimi.com', 'api.kimi.com', 'auth.meta.com', 'api.meta.ai', 'radius.pi.dev']),
    authentication: 'Use /login inside Pi. If sign-in ends on a "site can’t be reached" page, copy the full URL from the address bar, paste it into Pi and press Enter.',
  },
  aider: profile('Aider', ['/usr/local/bin/aider', '/opt/aider/bin/python*', '/usr/bin/python3*', '/usr/local/bin/python3*'], modelProviders),
  copilot: profile('GitHub Copilot', [...node, '/usr/local/bin/copilot', '/usr/local/lib/node_modules/@github/**/copilot', '/usr/lib/node_modules/@github/**/copilot'], ['github.com', 'api.github.com', 'api.githubcopilot.com', '*.githubcopilot.com', 'copilot-proxy.githubusercontent.com']),
  cursor: {
    ...profile('Cursor', ['/sandbox/.local/bin/cursor-agent', '/sandbox/.local/share/cursor-agent/**', '/usr/local/bin/cursor-agent'], []),
    endpoints: [
      ...['cursor.com', 'api2.cursor.sh', 'api3.cursor.sh', '*.cursor.sh', '*.cursorapi.com'].map(host => endpoint(host)),
      // The nested agent host needs an explicit rule. REST inspection rejects
      // its TLS ALPN negotiation; keep its encrypted transport intact.
      { host: 'agentn.global.api5.cursor.sh', ports: [443], protocol: 'tcp', tlsSkip: true },
    ],
  },
  antigravity: {
    ...profile('Antigravity', ['/sandbox/.local/bin/agy', '/sandbox/.antigravity/**', '/sandbox/.local/share/antigravity/**', '/usr/local/bin/agy', ...node], []),
    endpoints: [
      ...[...google, 'antigravity.google', 'daily-cloudcode-pa.googleapis.com', 'daily-cloudcode-pa.sandbox.googleapis.com'].map(antigravityEndpoint),
      // Sign-in eligibility fetches the Google account's profile picture.
      endpoint('lh3.googleusercontent.com', 'read-only'),
    ],
  },
  kiro: profile('Kiro', ['/sandbox/.local/bin/kiro-cli', '/sandbox/.local/bin/kiro-cli-chat', '/usr/local/bin/kiro-cli'], ['app.kiro.dev', 'prod.us-east-1.auth.desktop.kiro.dev', 'runtime.us-east-1.kiro.dev', 'runtime.eu-central-1.kiro.dev', 'management.us-east-1.kiro.dev', 'management.eu-central-1.kiro.dev', 'q.us-east-1.amazonaws.com', 'q.eu-central-1.amazonaws.com', 'oidc.us-east-1.amazonaws.com', 'oidc.eu-central-1.amazonaws.com', 'cognito-identity.us-east-1.amazonaws.com', 'view.awsapps.com']),
  droid: profile('Factory Droid', ['/sandbox/.local/bin/droid', '/sandbox/.factory/bin/**', '/usr/local/bin/droid'], ['factory.ai', '*.factory.ai', ...modelProviders]),
}

// Image tools chosen as recipe runtimes. VS Code Remote-SSH downloads a server
// matching the user's VS Code version when it connects, so the image cannot
// ship it: the sandbox fetches it with curl (or wget), then the server's CLI.
const download = (host) => ({ host, ports: [443], protocol: 'rest', enforcement: 'enforce', allow: [{ method: 'GET', path: '/**' }] })
export const TOOL_ACCESS = {
  vscode: {
    name: 'VS Code Server',
    rule: 'tool-vscode-server',
    binaries: ['/usr/bin/curl', '/usr/bin/wget', '/sandbox/.vscode-server/**'],
    endpoints: ['update.code.visualstudio.com', 'vscode.download.prss.microsoft.com'].map(download),
  },
}

// Agents whose subscription brings its own connectors (remote MCPs). They stay
// off unless chosen at creation.
export const connectorAgents = (ids = []) => ids.filter(id => AGENT_ACCESS[id]?.connectors)

function withConnectors(access, on) {
  const { hosts = [], paths = {} } = access.connectors ?? {}
  const endpoints = access.endpoints.map(e => !on && paths[e.host] ? { ...e, deny: [...(e.deny ?? []), ...paths[e.host].map(path => ({ method: '*', path }))] } : e)
  return { ...access, endpoints: on ? [...endpoints, ...hosts.map(host => endpoint(host))] : endpoints }
}

export function agentAccessFor(recipe, { connectors = [] } = {}) {
  // Only built recipes have known installation locations. An existing image
  // keeps its policy as chosen; we do not guess what it contains.
  if (recipe?.source !== 'build') return { profiles: [], unsupported: [] }
  const ids = [...new Set(recipe.agents ?? [])]
  if (!Array.isArray(connectors) || connectors.some(id => !connectorAgents(ids).includes(id))) throw new Error('Connectors can be turned on only for this sandbox’s Claude Code or Codex.')
  return {
    profiles: [...ids.filter(id => AGENT_ACCESS[id]).map(id => ({ id, rule: `agent-${id}`, ...withConnectors(AGENT_ACCESS[id], connectors.includes(id)) })), ...[...new Set(recipe.runtimes ?? [])].filter(id => TOOL_ACCESS[id]).map(id => ({ id, ...TOOL_ACCESS[id] }))],
    unsupported: ids.filter(id => !AGENT_ACCESS[id]),
  }
}

export function agentAccessRules(recipe, options) {
  const { profiles, unsupported } = agentAccessFor(recipe, options)
  if (unsupported.length) throw new Error(`Automatic network access is not configured for: ${unsupported.join(', ')}. Add a reviewed agent access profile before launching this template.`)
  return profiles.map(({ rule, binaries, endpoints }) => ({ name: rule, binaries, endpoints }))
}
