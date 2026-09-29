// Shared recipe model. Image recipes never contain or grant security policy.
export const BASES = [
  { id: 'ubuntu:24.04', name: 'Ubuntu 24.04' },
  { id: 'debian:12-slim', name: 'Debian 12 slim' },
]
export const DEFAULT_PACKAGES = ['git', 'curl', 'ripgrep']
export const AGENTS = [
  { id: 'claude', name: 'Claude Code', logo: '/logos/claude-code.svg', command: 'claude' },
  { id: 'codex', name: 'Codex', logo: '/logos/codex.svg', command: 'codex' },
]
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

export function newRecipe(values = {}) {
  return { name: '', source: 'build', agents: ['claude'], repository: '', runtimes: [], base: BASES[0].id, packages: [...DEFAULT_PACKAGES], setup: '', image: '', environment: [], command: 'claude', ...values }
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
    ? { source: 'image', image: r.image, command: r.command }
    : { source: 'build', agents: r.agents, repository: r.repository, runtimes: r.runtimes, base: r.base, packages: r.packages, setup: r.setup, command: r.command }
}
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'"
const imagePattern = /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,255}$/
export function recipeErrors(recipe) {
  const errors = {}
  if (!NAME_PATTERN.test(recipe.name || '')) errors.name = 'Use lowercase letters, digits and dashes for the name, up to 19 characters.'
  if (recipe.source === 'build') {
    if (!Array.isArray(recipe.agents) || recipe.agents.some((r) => !AGENTS.some((a) => a.id === r))) errors.agents = 'Choose a supported agent.'
    if (!Array.isArray(recipe.runtimes) || recipe.runtimes.some((r) => !RUNTIMES.some((x) => x.id === r))) errors.runtimes = 'Choose a supported runtime.'
    if (typeof recipe.repository !== 'string') errors.repository = 'Invalid repository.'
    else if (recipe.repository) {
      try { const u = new URL(recipe.repository); if (/[\r\n\0]/.test(recipe.repository) || u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) throw new Error() } catch { errors.repository = 'Use a public HTTPS repository URL without credentials or query parameters.' }
    }
    if (!BASES.some((b) => b.id === recipe.base)) errors.base = 'Choose a supported base image.'
    if (!Array.isArray(recipe.packages) || recipe.packages.length > 80 || recipe.packages.some((p) => typeof p !== 'string' || !/^[a-z0-9][a-z0-9+.-]*(=[a-zA-Z0-9:.+~_-]+)?$/.test(p))) errors.packages = 'Use valid apt package names, separated by spaces.'
    if (typeof recipe.setup !== 'string' || recipe.setup.length > 6000) errors.setup = 'Setup commands must be under 6 KB.'
  } else if (recipe.source === 'image') {
    if (!imagePattern.test(recipe.image || '')) errors.image = 'Enter a valid image reference, such as team/workspace:latest.'
  } else errors.source = 'Choose an image source.'
  if (!Array.isArray(recipe.environment) || recipe.environment.length > 40 || recipe.environment.some((e) => !e || typeof e.name !== 'string' || typeof e.value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(e.name) || /secret|token|password|api_?key|credential|auth/i.test(e.name) || /[\r\n\0]/.test(e.value) || e.value.length > 1000)) errors.environment = 'Use valid non-secret variable names and single-line values. Attach credentials through Secrets when launching.'
  else if (new Set(recipe.environment.map((e) => e.name)).size !== recipe.environment.length) errors.environment = 'Environment variable names must be unique.'
  if (typeof recipe.command !== 'string' || recipe.command.length > 512 || /[\r\n\0]/.test(recipe.command)) errors.command = 'Use a single-line start command, up to 512 characters.'
  if (!Object.keys(errors).length && new TextEncoder().encode(JSON.stringify(storedRecipe(recipe))).length > MAX_RECIPE_BYTES) errors.setup = 'This recipe is too large to store with the template. Shorten the setup commands or package list.'
  return errors
}

export function dockerfileFor(recipe) {
  const hasNode = recipe.runtimes.includes('node') || recipe.agents.includes('codex')
  const hasPython = recipe.runtimes.includes('python')
  const packages = [...new Set(['ca-certificates', 'curl', 'iproute2', ...recipe.packages, ...(recipe.repository ? ['git'] : []), ...(hasPython ? ['python3', 'python3-venv'] : [])])]
  const lines = [`FROM ${recipe.base}`, '', 'USER root', 'ENV DEBIAN_FRONTEND=noninteractive', `RUN apt-get update && apt-get install -y --no-install-recommends ${packages.map(quote).join(' ')} && rm -rf /var/lib/apt/lists/*`, 'RUN if getent passwd 1000 >/dev/null; then usermod --login sandbox --home /sandbox --move-home --shell /bin/bash "$(getent passwd 1000 | cut -d: -f1)"; else useradd --uid 1000 --create-home --home-dir /sandbox --shell /bin/bash sandbox; fi && chown -R 1000:1000 /sandbox']
  if (hasNode) lines.push('', 'COPY --from=node:22-bookworm-slim /usr/local/ /usr/local/')
  if (hasPython) lines.push('', 'RUN python3 -m venv /usr/local/venv', 'ENV PATH="/usr/local/venv/bin:${PATH}"')
  if (recipe.agents.includes('codex')) lines.push('RUN npm install --global @openai/codex')
  if (recipe.agents.includes('claude')) lines.push('RUN curl -fsSL https://claude.ai/install.sh -o /tmp/install-claude.sh && bash /tmp/install-claude.sh && cp -L /root/.local/bin/claude /usr/local/bin/claude && chmod 0755 /usr/local/bin/claude && rm -rf /root/.local /root/.claude* /tmp/install-claude.sh')
  lines.push('', 'ENV HOME=/sandbox', 'USER sandbox', 'WORKDIR /sandbox')
  if (recipe.repository) lines.push(`RUN git clone -- ${quote(recipe.repository)} /sandbox/project`, 'WORKDIR /sandbox/project')
  if (recipe.setup.trim()) lines.push('COPY --chown=1000:1000 setup.sh /tmp/template-setup.sh', 'RUN bash -eu /tmp/template-setup.sh')
  // Environment and the start command live in the OpenShell template, not in image layers.
  lines.push('', 'CMD ["/bin/bash"]', '')
  return lines.join('\n')
}
