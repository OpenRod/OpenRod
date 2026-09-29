// Shared recipe model. Image recipes never contain or grant security policy.
export const BASES = [
  { id: 'ubuntu:24.04', name: 'Ubuntu', version: '24.04 LTS', logo: '/logos/templates/ubuntu.svg', description: 'A familiar, versatile starting point.' },
  { id: 'debian:12-slim', name: 'Debian', version: '12 slim', logo: '/logos/templates/debian.svg', description: 'A smaller foundation with the essentials.' },
]
export const PACKAGES = ['git', 'curl', 'wget', 'jq', 'ripgrep', 'unzip', 'build-essential', 'ffmpeg']
export const AGENTS = [
  { id: 'claude', name: 'Claude Code', logo: '/logos/claude-code.svg', command: 'claude' },
  { id: 'codex', name: 'Codex', logo: '/logos/codex.svg', command: 'codex' },
]
export const STARTERS = [
  { name: 'Frontend development', description: 'Node.js, Git, and your coding agent.', runtimes: ['node'], packages: ['git', 'curl', 'ripgrep'], agents: ['claude'], command: 'claude' },
  { name: 'Python workspace', description: 'Python, pip, and everyday utilities.', runtimes: ['python'], packages: ['git', 'curl'], agents: [], command: '' },
  { name: 'Minimal sandbox', description: 'A clean Ubuntu environment. Make it yours.', runtimes: [], packages: ['git', 'curl'], agents: [], command: '' },
]
export function newRecipe(starter = {}) {
  return { name: '', description: '', source: 'wizard', base: BASES[0].id, image: '', packages: ['git', 'curl'], runtimes: [], agents: [], npm: [], pip: [], repository: '', files: [], environment: [], setup: '', command: '', ...starter }
}
export const splitPackages = (text) => text.split(/[\s,]+/).filter(Boolean)
export const PENDING_RECIPE_KEY = 'openshell-image-recipe-v1'
export function pendingRecipe() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(PENDING_RECIPE_KEY))
    return saved?.recipe && typeof saved.recipe.name === 'string' ? saved : null
  } catch { return null }
}
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
    if (typeof recipe.setup !== 'string' || recipe.setup.length > 12000) errors.setup = 'Setup commands must be under 12 KB.'
  } else if (!['local', 'registry', 'archive'].includes(recipe.source)) errors.source = 'Choose an image source.'
  if (['local', 'registry'].includes(recipe.source) && !imagePattern.test(recipe.image || '')) errors.image = 'Enter a valid image reference, such as team/workspace:latest.'
  if (!Array.isArray(recipe.environment) || recipe.environment.length > 40 || recipe.environment.some((e) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(e.name) || /secret|token|password|api_?key|credential|auth/i.test(e.name) || typeof e.value !== 'string' || /[\r\n\0]/.test(e.value) || e.value.length > 1000)) errors.environment = 'Use valid non-secret variable names and single-line values. Attach credentials through Secrets when launching.'
  if (new Set(recipe.environment?.map((e) => e.name)).size !== recipe.environment?.length) errors.environment = 'Environment variable names must be unique.'
  if (typeof recipe.command !== 'string' || recipe.command.length > 512 || /[\r\n\0]/.test(recipe.command)) errors.command = 'Use a single-line startup command, up to 512 characters.'
  return errors
}

export function dockerfileFor(recipe) {
  const hasNode = recipe.runtimes.includes('node') || recipe.agents.includes('codex') || recipe.npm.length > 0
  const hasPython = recipe.runtimes.includes('python') || recipe.pip.length > 0
  const packages = [...new Set(['ca-certificates', 'curl', 'iproute2', ...recipe.packages, ...(recipe.repository ? ['git'] : []), ...(hasPython ? ['python3', 'python3-venv'] : [])])]
  const lines = [`FROM ${recipe.base}`, '', 'USER root', 'ENV DEBIAN_FRONTEND=noninteractive', `RUN apt-get update && apt-get install -y --no-install-recommends ${packages.map(quote).join(' ')} && rm -rf /var/lib/apt/lists/*`, 'RUN if getent passwd 1000 >/dev/null; then usermod --login sandbox --home /sandbox --move-home --shell /bin/bash "$(getent passwd 1000 | cut -d: -f1)"; else useradd --uid 1000 --create-home --home-dir /sandbox --shell /bin/bash sandbox; fi && chown -R 1000:1000 /sandbox']
  if (hasNode) lines.push('', 'COPY --from=node:22-bookworm-slim /usr/local/ /usr/local/')
  if (hasPython) lines.push('', 'RUN python3 -m venv /usr/local/venv', 'ENV PATH="/usr/local/venv/bin:${PATH}"')
  if (recipe.npm.length) lines.push(`RUN npm install --global -- ${recipe.npm.map(quote).join(' ')}`)
  if (recipe.pip.length) lines.push(`RUN pip install --no-cache-dir -- ${recipe.pip.map(quote).join(' ')}`)
  if (recipe.agents.includes('codex')) lines.push('RUN npm install --global @openai/codex')
  if (recipe.agents.includes('claude')) lines.push('RUN curl -fsSL https://claude.ai/install.sh -o /tmp/install-claude.sh && bash /tmp/install-claude.sh && cp -L /root/.local/bin/claude /usr/local/bin/claude && chmod 0755 /usr/local/bin/claude && rm -rf /root/.local /root/.claude* /tmp/install-claude.sh')
  lines.push('', 'ENV HOME=/sandbox', 'USER sandbox', 'WORKDIR /sandbox')
  if (recipe.repository) lines.push(`RUN git clone -- ${quote(recipe.repository)} /sandbox/project`, 'WORKDIR /sandbox/project')
  recipe.files.forEach((file, i) => lines.push(`COPY --chown=1000:1000 ${JSON.stringify([`files/${i}`, `/sandbox/${recipe.repository ? 'project/' : ''}${file.path}`])}`))
  if (recipe.setup.trim()) lines.push('COPY --chown=1000:1000 setup.sh /tmp/template-setup.sh', 'RUN bash -eu /tmp/template-setup.sh')
  // Launch variables and commands remain outside immutable image layers.
  lines.push('', 'CMD ["/bin/bash"]', '')
  return lines.join('\n')
}
