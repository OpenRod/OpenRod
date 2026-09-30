import { AGENTS as AGENT_CATALOG } from './agents.js'

// Image recipes declare installed agents. Reviewed agent access is composed at launch; arbitrary policy is never accepted from recipes.
export const BASES = [
  { id: 'ubuntu:24.04', name: 'Ubuntu', version: '24.04 LTS', logo: '/logos/templates/ubuntu.svg', description: 'A familiar, versatile starting point.' },
  { id: 'debian:12-slim', name: 'Debian', version: '12 slim', logo: '/logos/templates/debian.svg', description: 'A smaller foundation with the essentials.' },
]
export const PACKAGES = ['git', 'curl', 'wget', 'jq', 'ripgrep', 'unzip', 'build-essential', 'ffmpeg']
const installer = (url, shell = 'bash') => `curl -fsSL ${url} -o /tmp/install-agent.sh && ${shell} /tmp/install-agent.sh && rm /tmp/install-agent.sh`
const choices = [
  { id: 'claude', command: 'claude', featured: true },
  { id: 'codex', command: 'codex', featured: true, npm: '@openai/codex' },
  { id: 'opencode', command: 'opencode', featured: true, npm: 'opencode-ai' },
  { id: 'pi', command: 'pi', npm: '@earendil-works/pi-coding-agent', ignoreScripts: true },
  { id: 'cursor', command: 'cursor-agent', install: installer('https://cursor.com/install') },
  { id: 'antigravity', command: 'agy', install: installer('https://antigravity.google/cli/install.sh') },
  { id: 'copilot', command: 'copilot', npm: '@github/copilot' },
  { id: 'kiro', command: 'kiro-cli', packages: ['unzip'], install: installer('https://cli.kiro.dev/install') },
  { id: 'droid', command: 'droid', install: installer('https://app.factory.ai/cli', 'sh') },
  { id: 'aider', command: 'aider', python: true },
]
export const AGENTS = choices.map((choice) => {
  const agent = AGENT_CATALOG.find((agent) => agent.commands.includes(choice.command))
  return { ...choice, name: agent.name, logo: `/logos/agents/${agent.logo}.svg` }
})
export const selectedAgents = (recipe) => AGENTS.filter((a) => recipe.agents.includes(a.id))
export const STARTERS = [
  { name: 'Frontend development', description: 'Node.js, Git, and your coding agent.', runtimes: ['node'], packages: ['git', 'curl', 'ripgrep'], agents: ['claude'], command: 'claude' },
  { name: 'Python workspace', description: 'Python, pip, and everyday utilities.', runtimes: ['python'], packages: ['git', 'curl'], agents: [], command: '' },
  { name: 'Minimal sandbox', description: 'A clean Ubuntu environment. Make it yours.', runtimes: [], packages: ['git', 'curl'], agents: [], command: '' },
]
export function newRecipe(starter = {}) {
  return { name: '', description: '', source: 'wizard', base: BASES[0].id, image: '', packages: ['git', 'curl'], runtimes: [], agents: [], customAgentInstall: '', npm: [], pip: [], repository: '', files: [], environment: [], setup: '', command: '', ...starter }
}
export const splitPackages = (text) => text.split(/[\s,]+/).filter(Boolean)
export const PENDING_RECIPE_KEY = 'openshell-image-recipe-v1'
export function pendingRecipe() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(PENDING_RECIPE_KEY))
    return saved?.recipe && typeof saved.recipe.name === 'string' ? saved : null
  } catch { return null }
}
// Codex's browser sign-in redirects to a callback server inside the sandbox,
// which the host browser cannot reach. The launcher offers the two sign-in
// methods that work without that callback before starting the real CLI.
const CODEX_ENTRY = '/usr/local/lib/node_modules/@openai/codex/bin/codex.js'
export const CODEX_LAUNCHER = `#!/bin/bash
# OpenShell Codex launcher: device-code or API-key sign-in, then Codex.
codex=${CODEX_ENTRY}
case "\${1-}" in login|logout|help|completion|-h|--help|-V|--version) exec "$codex" "$@" ;; esac
if [ -t 0 ] && [ -t 1 ] && ! "$codex" login status >/dev/null 2>&1; then
  printf 'Sign in to Codex:\\n  1. Device code (ChatGPT plan)\\n  2. API key\\n'
  while :; do
    read -rp 'Choose 1 or 2: ' choice || exit 1
    case "$choice" in
      1) "$codex" login --device-auth && break ;;
      2) read -rsp 'API key: ' key || exit 1; echo
         printf '%s' "$key" | "$codex" login --with-api-key && break ;;
    esac
  done
  unset key
fi
exec "$codex" "$@"
`
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'"
const imagePattern = /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,255}$/
export function recipeErrors(recipe) {
  const errors = {}
  if (!recipe.name?.trim() || recipe.name.length > 80) errors.name = 'Give your template a name (up to 80 characters).'
  if (recipe.source === 'wizard') {
    if (!BASES.some((b) => b.id === recipe.base)) errors.base = 'Choose a supported base image.'
    if (!Array.isArray(recipe.packages) || recipe.packages.length > 80 || recipe.packages.some((p) => !/^[a-z0-9][a-z0-9+.-]*(=[a-zA-Z0-9:.+~_-]+)?$/.test(p))) errors.packages = 'Use valid apt package names, separated by spaces.'
    if (!Array.isArray(recipe.runtimes) || recipe.runtimes.some((r) => !['node', 'python'].includes(r))) errors.runtimes = 'Choose a supported runtime.'
    if (!Array.isArray(recipe.agents) || recipe.agents.some((r) => !AGENTS.some((a) => a.id === r))) errors.agents = 'Choose a supported agent.'
    for (const key of ['npm', 'pip']) {
      if (!Array.isArray(recipe[key]) || recipe[key].length > 80 || recipe[key].some((p) => !/^[a-zA-Z0-9@][a-zA-Z0-9@/_.+<>=!~^-]{0,160}$/.test(p))) errors[key] = 'Use package names and optional versions; URLs and options are not supported.'
    }
    if (recipe.repository) {
      try { const u = new URL(recipe.repository); if (/[\r\n\0]/.test(recipe.repository) || u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) throw new Error() } catch { errors.repository = 'Use a public HTTPS repository URL without credentials or query parameters.' }
    }
    if (!Array.isArray(recipe.files) || recipe.files.length > 20 || recipe.files.some((f) => !/^[a-zA-Z0-9_.-][a-zA-Z0-9_./-]{0,160}$/.test(f.path) || f.path.split('/').some((p) => p === '..' || p === '.') || typeof f.content !== 'string' || f.content.length > 16000)) errors.files = 'Use relative file paths without ..; up to 20 files, 16 KB each.'
    if (new Set(recipe.files?.map((f) => f.path)).size !== recipe.files?.length) errors.files = 'Each file needs a unique path.'
    if (typeof (recipe.customAgentInstall ?? '') !== 'string' || (recipe.customAgentInstall ?? '').length > 12000 || /\0/.test(recipe.customAgentInstall ?? '')) errors.customAgentInstall = 'Custom agent commands must be text under 12 KB, without null characters.'
    if (typeof recipe.setup !== 'string' || recipe.setup.length > 12000) errors.setup = 'Setup commands must be under 12 KB.'
  } else if (!['local', 'registry', 'archive'].includes(recipe.source)) errors.source = 'Choose an image source.'
  if (['local', 'registry'].includes(recipe.source) && !imagePattern.test(recipe.image || '')) errors.image = 'Enter a valid image reference, such as team/workspace:latest.'
  if (!Array.isArray(recipe.environment) || recipe.environment.length > 40 || recipe.environment.some((e) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(e.name) || /secret|token|password|api_?key|credential|auth/i.test(e.name) || typeof e.value !== 'string' || /[\r\n\0]/.test(e.value) || e.value.length > 1000)) errors.environment = 'Use valid non-secret variable names and single-line values. Attach credentials through Secrets when launching.'
  if (new Set(recipe.environment?.map((e) => e.name)).size !== recipe.environment?.length) errors.environment = 'Environment variable names must be unique.'
  if (typeof recipe.command !== 'string' || recipe.command.length > 512 || /[\r\n\0]/.test(recipe.command)) errors.command = 'Use a single-line startup command, up to 512 characters.'
  return errors
}

export function dockerfileFor(recipe) {
  const agents = selectedAgents(recipe)
  const hasNode = recipe.runtimes.includes('node') || agents.some((a) => a.npm) || recipe.npm.length > 0
  const hasPython = recipe.runtimes.includes('python') || agents.some((a) => a.python) || recipe.pip.length > 0
  const packages = [...new Set(['ca-certificates', 'curl', 'iproute2', ...recipe.packages, ...agents.flatMap((a) => a.packages ?? []), ...(recipe.repository ? ['git'] : []), ...(hasPython ? ['python3', 'python3-venv'] : [])])]
  const lines = [`FROM ${recipe.base}`, '', 'USER root', 'ENV DEBIAN_FRONTEND=noninteractive', `RUN apt-get update && apt-get install -y --no-install-recommends ${packages.map(quote).join(' ')} && rm -rf /var/lib/apt/lists/*`, 'RUN if getent passwd 1000 >/dev/null; then usermod --login sandbox --home /sandbox --move-home --shell /bin/bash "$(getent passwd 1000 | cut -d: -f1)"; else useradd --uid 1000 --create-home --home-dir /sandbox --shell /bin/bash sandbox; fi && chown -R 1000:1000 /sandbox']
  if (hasNode) lines.push('', 'COPY --from=node:22-bookworm-slim /usr/local/ /usr/local/')
  if (hasPython) lines.push('', 'RUN python3 -m venv /usr/local/venv', 'ENV PATH="/usr/local/venv/bin:${PATH}"')
  if (recipe.npm.length) lines.push(`RUN npm install --global -- ${recipe.npm.map(quote).join(' ')}`)
  if (recipe.pip.length) lines.push(`RUN pip install --no-cache-dir -- ${recipe.pip.map(quote).join(' ')}`)
  for (const agent of agents.filter((a) => a.npm)) lines.push(`RUN npm install --global ${agent.ignoreScripts ? '--ignore-scripts ' : ''}${agent.npm}`)
  // COPY would follow npm's codex symlink and overwrite the real entry point.
  if (recipe.agents.includes('codex')) lines.push('COPY codex-launcher.sh /usr/local/libexec/openshell-codex', `RUN test -x ${CODEX_ENTRY} && chmod 0755 /usr/local/libexec/openshell-codex && ln -sfn /usr/local/libexec/openshell-codex /usr/local/bin/codex`)
  if (recipe.agents.includes('aider')) lines.push('RUN python3 -m venv /opt/aider && /opt/aider/bin/pip install --no-cache-dir aider-chat && ln -s /opt/aider/bin/aider /usr/local/bin/aider')
  if (recipe.agents.includes('claude')) lines.push('RUN curl -fsSL https://claude.ai/install.sh -o /tmp/install-claude.sh && bash /tmp/install-claude.sh && cp -L /root/.local/bin/claude /usr/local/bin/claude && chmod 0755 /usr/local/bin/claude && rm -rf /root/.local /root/.claude* /tmp/install-claude.sh')
  lines.push('', 'ENV HOME=/sandbox', 'ENV PATH="/sandbox/.local/bin:/sandbox/.npm-global/bin:/sandbox/.opencode/bin:${PATH}"', 'ENV NPM_CONFIG_PREFIX=/sandbox/.npm-global', 'USER sandbox', 'WORKDIR /sandbox')
  for (const agent of agents.filter((a) => a.install)) lines.push(`RUN ${agent.install} && command -v ${agent.command}`)
  if (recipe.customAgentInstall?.trim()) lines.push('COPY --chown=1000:1000 custom-agents.sh /tmp/custom-agents.sh', 'RUN bash -euo pipefail /tmp/custom-agents.sh')
  if (recipe.repository) lines.push(`RUN git clone -- ${quote(recipe.repository)} /sandbox/project`, 'WORKDIR /sandbox/project')
  recipe.files.forEach((file, i) => lines.push(`COPY --chown=1000:1000 ${JSON.stringify([`files/${i}`, `/sandbox/${recipe.repository ? 'project/' : ''}${file.path}`])}`))
  if (recipe.setup.trim()) lines.push('COPY --chown=1000:1000 setup.sh /tmp/template-setup.sh', 'RUN bash -eu /tmp/template-setup.sh')
  // Launch variables and commands remain outside immutable image layers.
  lines.push('', 'CMD ["/bin/bash"]', '')
  return lines.join('\n')
}
