import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { MAX_RECIPE_BYTES, RECIPE_ANNOTATION, newRecipe, recipeErrors, dockerfileFor, storedRecipe } from '../src/lib/image-templates.js'
import { imageTemplateRoute, templateView } from './image-templates.js'

test('custom installs round-trip and run after runtimes and before repository setup', () => {
  const customAgents = [
    { name: 'Team agent', install: 'printf "%s\\n" "quoted value"\nprintf "%s\\n" "second line"' },
    { name: 'Other agent', install: 'printf done' },
  ]
  const recipe = newRecipe({ name: 'custom', agents: ['codex'], customAgents, runtimes: ['node'], repository: 'https://github.com/example/project.git', setup: 'npm ci' })
  assert.deepEqual(recipeErrors(recipe), {})
  assert.equal(recipe.command, '')
  const stored = storedRecipe(recipe)
  const view = templateView({ metadata: { name: 'custom', annotations: { [RECIPE_ANNOTATION]: JSON.stringify(stored) } }, spec: { workload: { image: 'test:1' } } })
  assert.equal(view.managed, true)
  assert.deepEqual(view.recipe.customAgents, customAgents)
  const dockerfile = dockerfileFor(recipe)
  const runs = dockerfile.split('\n').filter((line) => line.startsWith('RUN ['))
  assert.equal(runs.length, 2)
  const args = JSON.parse(runs[0].slice(4))
  assert.equal(args.at(-1), customAgents[0].install)
  const output = spawnSync(args[0], args.slice(1), { encoding: 'utf8' })
  assert.equal(output.status, 0)
  assert.equal(output.stdout, 'quoted value\nsecond line\n')
  const stages = ['apt-get install', 'COPY --from=node:', 'npm install --global', 'USER sandbox', runs[0], runs[1], 'RUN git clone', 'RUN bash -eu /tmp/template-setup.sh']
  for (let i = 1; i < stages.length; i++) assert.ok(dockerfile.indexOf(stages[i]) > dockerfile.indexOf(stages[i - 1]), stages[i])
  const failure = spawnSync(args[0], [...args.slice(1, -1), 'false | cat\nprintf should-not-run'], { encoding: 'utf8' })
  assert.notEqual(failure.status, 0)
  assert.equal(failure.stdout, '')
})

test('invalid custom agent input is rejected before starting a build', async () => {
  for (const customAgents of [null, [null], [{ name: '', install: 'echo ok' }], [{ name: 'Agent', install: '' }], [{ name: 'Agent', install: 'x'.repeat(6001) }], [{ name: 'Agent', install: 'echo\0bad' }]]) {
    const recipe = newRecipe({ name: 'custom', customAgents })
    assert.ok(recipeErrors(recipe).customAgents)
    await assert.rejects(imageTemplateRoute('POST', ['image-templates'], { recipe }))
  }
  assert.deepEqual(newRecipe().customAgents, [])
  assert.equal(newRecipe({ agents: [], customAgents: [{ name: 'One', install: 'true' }, { name: 'Two', install: 'true' }], command: 'custom' }).command, '')
})

test('image recipe does not compile launch variables or permissions into an image', () => {
  const recipe = newRecipe({ name: 'frontend', runtimes: ['node', 'python'], agents: ['codex'], environment: [{ name: 'APP_MODE', value: 'development' }], command: 'codex', policy: { rules: ['allow-all'] } })
  assert.deepEqual(recipeErrors(recipe), {})
  const result = dockerfileFor(recipe)
  assert.match(result, /COPY --from=node:22-bookworm-slim/)
  assert.match(result, /python3 -m venv/)
  assert.match(result, /npm install --global @openai\/codex/)
  assert.match(result, /USER sandbox/)
  assert.doesNotMatch(result, /APP_MODE|development|allow-all/)
})

test('the default recipe installs Claude Code and starts in it', () => {
  const recipe = newRecipe({ name: 'app' })
  assert.deepEqual(recipeErrors(recipe), {})
  assert.equal(recipe.command, 'claude')
  assert.match(dockerfileFor(recipe), /claude\.ai\/install\.sh/)
})

test('multiple agents always start in Shell, including restored templates', () => {
  for (const command of ['claude', 'codex', 'npm run dev', '']) {
    const recipe = newRecipe({ name: 'team', agents: ['claude', 'codex'], command })
    assert.equal(recipe.command, '')
    assert.deepEqual(recipeErrors(recipe), {})
    assert.equal(storedRecipe(recipe).command, '')
    assert.ok(recipeErrors({ ...recipe, command: 'claude' }).command)
    const legacy = { ...storedRecipe(recipe), command }
    const view = templateView({ metadata: { name: 'team', annotations: { [RECIPE_ANNOTATION]: JSON.stringify(legacy) } }, spec: { workload: { image: 'openshell-template/team:1' } } })
    assert.equal(view.managed, true)
    assert.equal(view.recipe.command, '')
  }
  assert.equal(newRecipe({ agents: ['codex'], command: 'codex' }).command, 'codex')
  assert.equal(newRecipe({ agents: [], command: 'npm run dev' }).command, 'npm run dev')
  assert.equal(newRecipe({ source: 'image', agents: ['claude', 'codex'], command: 'npm run dev' }).command, 'npm run dev')
})

test('rejects names OpenShell would refuse, shell options, Dockerfile injection, credential variables and credentialed repositories', () => {
  for (const [patch, field] of [
    [{ name: 'Frontend App' }, 'name'],
    [{ name: '-app' }, 'name'],
    [{ name: 'a-name-longer-than-19' }, 'name'],
    [{ base: 'ubuntu:24.04\nRUN whoami' }, 'base'],
    [{ packages: ['git;echo nope'] }, 'packages'],
    [{ image: '--help', source: 'image' }, 'image'],
    [{ environment: [{ name: 'API_KEY', value: 'not-a-real-key' }] }, 'environment'],
    [{ environment: [{ name: 'OPENSHELL_ENV', value: 'dev' }] }, 'environment'],
    [{ environment: [{ name: 'X'.repeat(129), value: 'dev' }] }, 'environment'],
    [{ environment: [{ name: 'MODE', value: 'a\tb' }] }, 'environment'],
    [{ repository: 'https://user:password@example.com/repo' }, 'repository'],
    [{ repository: 'https://example.com/repo\nRUN echo nope' }, 'repository'],
  ]) assert.ok(recipeErrors(newRecipe({ name: 'test', ...patch }))[field], field)
})

test('the stored recipe fits in one gateway annotation and leaves environment to the template', () => {
  const recipe = newRecipe({ name: 'app', environment: [{ name: 'MODE', value: 'dev' }], setup: 'npm ci' })
  const stored = storedRecipe(recipe)
  assert.equal(stored.name, undefined)
  assert.equal(stored.environment, undefined)
  assert.equal(stored.setup, 'npm ci')
  assert.ok(recipeErrors(newRecipe({ name: 'app', setup: 'x'.repeat(5999), packages: Array.from({ length: 80 }, (_, i) => `package-${i}-${"x".repeat(40)}`) })).setup)
  assert.ok(new TextEncoder().encode(JSON.stringify(storedRecipe(newRecipe({ name: 'app', setup: 'x'.repeat(5000) })))).length <= MAX_RECIPE_BYTES)
})

test('templates read back from the gateway restore the recipe, and CLI templates stay launch-only', () => {
  const stored = storedRecipe(newRecipe({ name: 'app', repository: 'https://github.com/example/project.git', command: 'codex', agents: ['codex'] }))
  const view = templateView({ metadata: { name: 'app', annotations: { [RECIPE_ANNOTATION]: JSON.stringify(stored) } }, spec: { workload: { image: 'openshell-template/app:1', environment: { MODE: 'dev' } } } })
  assert.equal(view.managed, true)
  assert.equal(view.recipe.name, 'app')
  assert.equal(view.recipe.command, 'codex')
  assert.equal(view.recipe.repository, 'https://github.com/example/project.git')
  assert.deepEqual(view.recipe.environment, [{ name: 'MODE', value: 'dev' }])
  for (const annotation of ['{"command":42}', '{"agents":"claude"}', '[]', 'not json']) {
    const broken = templateView({ metadata: { name: 'hand-written', annotations: { [RECIPE_ANNOTATION]: annotation } }, spec: { workload: { image: 'alpine:3' } } })
    assert.equal(broken.managed, false, annotation)
    assert.equal(broken.recipe.command, '')
    assert.ok(Array.isArray(broken.recipe.agents))
  }
  const cli = templateView({ metadata: { name: 'from-cli' }, spec: { workload: { image: 'ghcr.io/example/box:1' } } })
  assert.equal(cli.managed, false)
  assert.equal(cli.recipe.source, 'image')
  assert.equal(cli.recipe.command, '')
})

test('invalid recipes and secret names fail before Docker or the gateway is touched', async () => {
  for (const recipe of [null, newRecipe(), newRecipe({ name: 'app', agents: [null] }), newRecipe({ name: 'app', environment: [{ name: 'ACCESS_TOKEN', value: 'fake' }] })]) {
    await assert.rejects(imageTemplateRoute('POST', ['image-templates'], { recipe }))
  }
  await assert.rejects(imageTemplateRoute('POST', ['image-templates', '../policy', 'delete'], {}), /Unknown image template/)
})

test('every agent choice generates an installer, its runtime, and a session', async () => {
  const { AGENTS } = await import('../src/lib/image-templates.js')
  const { isSession } = await import('../src/lib/sandbox-session.js')
  assert.equal(AGENTS.length, 10)
  assert.equal(AGENTS.filter((a) => a.featured).length, 4)
  for (const agent of AGENTS) {
    const recipe = newRecipe({ name: agent.id, agents: [agent.id], command: agent.command })
    assert.deepEqual(recipeErrors(recipe), {})
    assert.ok(isSession(agent.command), agent.command)
    const dockerfile = dockerfileFor(recipe)
    if (agent.npm) {
      assert.ok(dockerfile.includes(agent.npm))
      assert.match(dockerfile, /COPY --from=node:22-bookworm-slim/)
    } else if (agent.install) {
      assert.ok(dockerfile.includes(`RUN ${agent.install} && command -v ${agent.command}`))
      assert.ok(dockerfile.indexOf(`RUN ${agent.install}`) > dockerfile.indexOf('USER sandbox'))
    } else assert.ok(dockerfile.includes(agent.id === 'aider' ? 'aider-chat' : 'https://claude.ai/install.sh'))
  }
  assert.equal(isSession('rm'), false)
  assert.equal(isSession('toString'), false)
})

const deletionFixture = async ({ shared = false, sandbox = false, dockerError, listError, absent = false } = {}) => {
  const { deleteImageTemplate } = await import('./image-templates.js')
  const calls = []
  const template = (name) => ({ metadata: { name }, spec: { workload: { image: 'openshell-template/test:one' } } })
  const client = {
    sandboxTemplates: {
      get: async () => { if (absent) throw { code: 'not_found' }; return template('test') },
      listAll: async () => [template('test'), ...(shared ? [template('other')] : [])],
      delete: async (name) => { calls.push(['delete', name]) },
    },
    raw: { listSandboxes: async ({ pageToken }) => {
      if (listError) throw new Error('Gateway unavailable')
      if (!pageToken) return { sandboxes: [], nextPageToken: 'second' }
      return { sandboxes: sandbox ? [{ phase: 'stopped', spec: { template: { image: 'openshell-template/test:one' } } }] : [] }
    } },
  }
  const operation = () => deleteImageTemplate(client, 'test', {
    getEngine: async () => ({ endpoint: 'unix:///test.sock' }),
    docker: async (args, options) => { calls.push(['docker', args, options]); if (dockerError) throw new Error(dockerError) },
  })
  return { operation, calls }
}

test('template deletion removes its exact Docker reference before deleting the record, without force', async () => {
  const { operation, calls } = await deletionFixture()
  assert.equal((await operation()).imageCleanup.status, 'removed')
  assert.deepEqual(calls, [['docker', ['image', 'rm', '--', 'openshell-template/test:one'], { engine: { endpoint: 'unix:///test.sock' } }], ['delete', 'test']])
})

test('shared images and stopped sandbox references on later pages are retained explicitly', async () => {
  for (const options of [{ shared: true }, { sandbox: true }]) {
    const { operation, calls } = await deletionFixture(options)
    const result = await operation()
    assert.equal(result.imageCleanup.status, 'retained')
    assert.match(result.imageCleanup.reason, options.shared ? /another template/ : /existing sandbox/)
    assert.deepEqual(calls, [['delete', 'test']])
  }
})

test('Docker failures and unknown gateway usage preserve the template for retry', async () => {
  for (const options of [{ dockerError: 'image is being used by a container' }, { dockerError: 'Cannot connect to Docker daemon' }, { listError: true }]) {
    const { operation, calls } = await deletionFixture(options)
    await assert.rejects(operation())
    assert.equal(calls.some(([action]) => action === 'delete'), false)
  }
})

test('already absent Docker images and template records can be deleted idempotently', async () => {
  for (const options of [{ dockerError: 'Error response from daemon: No such image: openshell-template/test:one' }, { absent: true }]) {
    const { operation, calls } = await deletionFixture(options)
    assert.equal((await operation()).imageCleanup.status, 'absent')
    assert.deepEqual(calls.at(-1), ['delete', 'test'])
  }
})

test('image builds select the inspected engine and native platform despite an inherited AMD default', async () => {
  const { buildImage } = await import('./image-templates.js')
  const previous = process.env.DOCKER_DEFAULT_PLATFORM
  process.env.DOCKER_DEFAULT_PLATFORM = 'linux/amd64'
  try {
    const calls = []
    const engine = { endpoint: 'unix:///test/docker.sock', architecture: 'arm64' }
    await buildImage('test/native:1', '/test/context', engine, {}, async (args, options) => calls.push({ args, options }))
    assert.equal(calls.length, 1)
    const { args, options } = calls[0]
    assert.equal(args[args.indexOf('--platform') + 1], 'linux/arm64')
    assert.equal(options.engine, engine)
    assert.equal(args.at(-1), '/test/context')
  } finally {
    if (previous === undefined) delete process.env.DOCKER_DEFAULT_PLATFORM
    else process.env.DOCKER_DEFAULT_PLATFORM = previous
  }
})
