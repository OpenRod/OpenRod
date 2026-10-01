import { AGENTS as AGENT_CATALOG } from './agents.js'

// Shared recipe model. Image recipes declare installed agents; their reviewed
// network access is composed at launch. Recipes never carry policy themselves.
export const BASES = [
  { id: 'ubuntu:24.04', name: 'Ubuntu 24.04' },
  { id: 'debian:12-slim', name: 'Debian 12 slim' },
]
export const DEFAULT_PACKAGES = ['git', 'curl', 'ripgrep']
const installer = (url, shell = 'bash') => `curl -fsSL ${url} -o /tmp/install-agent.sh && ${shell} /tmp/install-agent.sh && rm /tmp/install-agent.sh`
const choices = [
  { id: 'claude', command: 'claude', featured: true },
  { id: 'codex', command: 'codex', featured: true, npm: '@openai/codex' },
  { id: 'opencode', command: 'opencode', featured: true, npm: 'opencode-ai' },
  { id: 'pi', command: 'pi', npm: '@earendil-works/pi-coding-agent', ignoreScripts: true },
  { id: 'cursor', command: 'cursor-agent', featured: true, install: installer('https://cursor.com/install') },
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
export const RUNTIMES = [
  { id: 'node', name: 'Node.js 22', logo: '/logos/templates/nodejs.svg' },
  { id: 'python', name: 'Python 3', logo: '/logos/templates/python.svg' },
]
// What a sandbox runs first. Agents and the shell open as sessions; anything
// else is a custom command.
export const STARTS = [...AGENTS.map((a) => ({ id: a.command, name: a.name })), { id: '', name: 'Shell' }]
// OpenShell template names follow its sandbox-name rule: a DNS label of at
// most 19 characters.
export const NAME_PATTERN = /^[a-z0-9]([a-z0-9-]{0,17}[a-z0-9])?$/
// The recipe travels with the OpenShell template as one annotation value,
// which the gateway caps at 8 KB.
export const MAX_RECIPE_BYTES = 8000
export const RECIPE_ANNOTATION = 'openshell.console/recipe'

export const requiresShell = (recipe) => recipe.source === 'build' && Array.isArray(recipe.agents) && (new Set(recipe.agents).size + (Array.isArray(recipe.customAgents) ? recipe.customAgents.length : 0)) > 1

export function newRecipe(values = {}) {
  const recipe = { name: '', source: 'build', agents: ['claude'], customAgents: [], repository: '', runtimes: [], base: BASES[0].id, packages: [...DEFAULT_PACKAGES], setup: '', image: '', environment: [], command: 'claude', setups: [], setupRevisions: {}, ...values }
  if (requiresShell(recipe)) recipe.command = ''
  return recipe
}
export const splitPackages = (text) => text.split(/[\s,]+/).filter(Boolean)
export const PENDING_RECIPE_KEY = 'openshell-image-recipe-v2'
export function pendingRecipe() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(PENDING_RECIPE_KEY))
    return saved?.recipe && typeof saved.recipe.name === 'string' ? saved : null
  } catch { return null }
}
// The part of a recipe stored in the annotation; environment lives in the
// template's own environment map.
export function storedRecipe(r) {
  return r.source === 'image'
    ? { source: 'image', image: r.image, command: r.command, ...(r.setups?.length ? { setups: r.setups, setupRevisions: r.setupRevisions || {} } : {}) }
    : { source: 'build', agents: r.agents, ...(r.setups?.length ? { setups: r.setups, setupRevisions: r.setupRevisions || {} } : {}), ...(r.customAgents?.length ? { customAgents: r.customAgents } : {}), repository: r.repository, runtimes: r.runtimes, base: r.base, packages: r.packages, setup: r.setup, command: r.command }
}
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'"
const imagePattern = /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,255}$/
export function recipeErrors(recipe) {
  const errors = {}
  if (!Array.isArray(recipe.setups) || recipe.setups.length > 8 || recipe.setups.some((id) => typeof id !== 'string' || !/^[a-f0-9]{24}$/.test(id)) || new Set(recipe.setups).size !== recipe.setups.length) errors.setups = 'Choose up to eight unique saved Setups.'
  if (recipe.setupRevisions && (typeof recipe.setupRevisions !== 'object' || Array.isArray(recipe.setupRevisions) || Object.entries(recipe.setupRevisions).some(([id, rev]) => !recipe.setups?.includes(id) || !/^[a-f0-9]{64}$/.test(rev)))) errors.setups = 'Invalid pinned Setup revision.'
  if (!NAME_PATTERN.test(recipe.name || '')) errors.name = 'Use lowercase letters, digits and dashes for the name, up to 19 characters.'
  if (recipe.source === 'build') {
    if (!Array.isArray(recipe.agents) || recipe.agents.some((r) => !AGENTS.some((a) => a.id === r))) errors.agents = 'Choose a supported agent.'
    if (!Array.isArray(recipe.runtimes) || recipe.runtimes.some((r) => !RUNTIMES.some((x) => x.id === r))) errors.runtimes = 'Choose a supported runtime.'
    if (typeof recipe.repository !== 'string') errors.repository = 'Invalid repository.'
    else if (recipe.repository) {
      try { const u = new URL(recipe.repository); if (/[\r\n\0]/.test(recipe.repository) || u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) throw new Error() } catch { errors.repository = 'Use a public HTTPS repository URL without credentials or query parameters.' }
    }
    if (!BASES.some((b) => b.id === recipe.base)) errors.base = 'Choose a supported base image.'
    if (!Array.isArray(recipe.packages) || recipe.packages.length > 80 || recipe.packages.some((p) => typeof p !== 'string' || !/^[a-z0-9][a-z0-9+.-]*(=[a-zA-Z0-9:.+~_-]+)?$/.test(p))) errors.packages = 'Add up to 80 valid apt package names, such as jq or build-essential.'
    if (!Array.isArray(recipe.customAgents) || recipe.customAgents.length > 10 || recipe.customAgents.some((a) => !a || typeof a.name !== 'string' || !a.name.trim() || a.name.length > 80 || /[\x00-\x1f\x7f]/.test(a.name) || typeof a.install !== 'string' || !a.install.trim() || a.install.length > 6000 || /[\x00\r]/.test(a.install))) errors.customAgents = 'Enter valid custom agent install commands, up to 6,000 characters.'
    if (typeof recipe.setup !== 'string' || recipe.setup.length > 6000) errors.setup = 'Setup commands must be under 6 KB.'
  } else if (recipe.source === 'image') {
    if (!imagePattern.test(recipe.image || '')) errors.image = 'Enter a valid image reference, such as team/workspace:latest.'
  } else errors.source = 'Choose an image source.'
  // The gateway's own rules come first, so a template never fails after its build.
  if (!Array.isArray(recipe.environment) || recipe.environment.length > 40 || recipe.environment.some((e) => !e || typeof e.name !== 'string' || typeof e.value !== 'string' || e.name.length > 128 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(e.name) || /[\x00-\x1f\x7f]/.test(e.value) || e.value.length > 1000)) errors.environment = 'Use variable names of letters, digits and underscores (up to 128) and single-line values (up to 1,000 characters).'
  else if (recipe.environment.some((e) => e.name.startsWith('OPENSHELL_'))) errors.environment = 'Variable names starting with OPENSHELL_ are reserved by OpenShell.'
  else if (recipe.environment.some((e) => /secret|token|password|api_?key|credential|auth/i.test(e.name))) errors.environment = 'Keep credentials out of templates. Attach them through Secrets when you launch.'
  else if (new Set(recipe.environment.map((e) => e.name)).size !== recipe.environment.length) errors.environment = 'Environment variable names must be unique.'
  if (typeof recipe.command !== 'string' || recipe.command.length > 512 || /[\r\n\0]/.test(recipe.command)) errors.command = 'Use a single-line start command, up to 512 characters.'
  if (requiresShell(recipe) && recipe.command !== '') errors.command = 'Templates with multiple agents must start in Shell.'
  if (!Object.keys(errors).length && new TextEncoder().encode(JSON.stringify(storedRecipe(recipe))).length > MAX_RECIPE_BYTES) errors.setup = 'This recipe is too large to store with the template. Shorten the setup commands or package list.'
  return errors
}

export function dockerfileFor(recipe) {
  const agents = selectedAgents(recipe)
  const hasNode = Boolean(recipe.setups?.length) || recipe.runtimes.includes('node') || agents.some((a) => a.npm)
  const hasPython = Boolean(recipe.setups?.length) || recipe.runtimes.includes('python') || agents.some((a) => a.python)
  const packages = [...new Set(['ca-certificates', 'curl', 'iproute2', ...recipe.packages, ...agents.flatMap((a) => a.packages ?? []), ...(recipe.repository ? ['git'] : []), ...(hasPython ? ['python3', 'python3-venv'] : [])])]
  const lines = [`FROM ${recipe.base}`, '', 'USER root', 'ENV DEBIAN_FRONTEND=noninteractive', `RUN apt-get update --error-on=any && apt-get install -y --no-install-recommends ${packages.map(quote).join(' ')} && rm -rf /var/lib/apt/lists/*`, 'RUN if getent passwd 1000 >/dev/null; then usermod --login sandbox --home /sandbox --move-home --shell /bin/bash "$(getent passwd 1000 | cut -d: -f1)"; else useradd --uid 1000 --create-home --home-dir /sandbox --shell /bin/bash sandbox; fi && chown -R 1000:1000 /sandbox']
  if (hasNode) lines.push('', 'COPY --from=node:22-bookworm-slim /usr/local/ /usr/local/')
  if (hasPython) lines.push('', 'RUN python3 -m venv /usr/local/venv', 'ENV PATH="/usr/local/venv/bin:${PATH}"')
  for (const agent of agents.filter((a) => a.npm)) lines.push(`RUN npm install --global ${agent.ignoreScripts ? '--ignore-scripts ' : ''}${agent.npm}`)
  if (recipe.agents.includes('aider')) lines.push('RUN python3 -m venv /opt/aider && /opt/aider/bin/pip install --no-cache-dir aider-chat && ln -s /opt/aider/bin/aider /usr/local/bin/aider')
  if (recipe.agents.includes('claude')) lines.push('RUN curl -fsSL https://claude.ai/install.sh -o /tmp/install-claude.sh && bash /tmp/install-claude.sh && cp -L /root/.local/bin/claude /usr/local/bin/claude && chmod 0755 /usr/local/bin/claude && rm -rf /root/.local /root/.claude* /tmp/install-claude.sh')
  lines.push('', 'ENV HOME=/sandbox', 'ENV PATH="/sandbox/.local/bin:/sandbox/.npm-global/bin:/sandbox/.opencode/bin:${PATH}"', 'ENV NPM_CONFIG_PREFIX=/sandbox/.npm-global', 'USER sandbox', 'WORKDIR /sandbox')
  for (const agent of agents.filter((a) => a.install)) lines.push(`RUN ${agent.install} && command -v ${agent.command}`)
  for (const agent of recipe.customAgents ?? []) lines.push(`RUN ${JSON.stringify(['/bin/bash', '-euo', 'pipefail', '-c', agent.install])}`)
  if (recipe.repository) lines.push(`RUN git clone -- ${quote(recipe.repository)} /sandbox/project`, 'WORKDIR /sandbox/project')
  if (recipe.setup.trim()) lines.push('COPY --chown=1000:1000 setup.sh /tmp/template-setup.sh', 'RUN bash -eu /tmp/template-setup.sh')
  if (recipe.setups?.length) lines.push('COPY --chown=1000:1000 setup-bundles/ /sandbox/.openshell/bundles/')
  // Environment and the start command live in the OpenShell template, not in image layers.
  lines.push('', 'CMD ["/bin/bash"]', '')
  return lines.join('\n')
}
