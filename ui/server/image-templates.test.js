import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { MAX_RECIPE_BYTES, RECIPE_ANNOTATION, newRecipe, pendingRecipe, pendingRecipeKey, recipeErrors, dockerfileFor, storedRecipe } from '../src/lib/image-templates.js'
import { imageTemplateRoute, localEngine, publishImageTemplate, templateView } from './image-templates.js'
import { contextKey, runWithContext } from './gateway.js'
import { scopedStateDirectory } from './paths.js'

test('draft recovery isolates gateway and workspace drafts and ignores unscoped drafts', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
  const saved = new Map()
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: (key) => saved.get(key) ?? null } })
  try {
    const origin = pendingRecipeKey(JSON.stringify(['gateway-a', 'alpha']))
    const workspace = pendingRecipeKey(JSON.stringify(['gateway-a', 'beta']))
    const gateway = pendingRecipeKey(JSON.stringify(['gateway-b', 'alpha']))
    const draft = { recipe: newRecipe({ name: 'same-name', setups: ['a'.repeat(24)] }), replace: true, advanced: true }
    saved.set('openshell-image-recipe-v2', JSON.stringify(draft))
    assert.equal(pendingRecipe(origin), null)
    saved.set(origin, JSON.stringify(draft))
    assert.deepEqual(pendingRecipe(origin), draft)
    assert.equal(pendingRecipe(workspace), null)
    assert.equal(pendingRecipe(gateway), null)
    const other = { recipe: newRecipe({ name: 'same-name', setups: ['b'.repeat(24)] }), replace: false }
    saved.set(workspace, JSON.stringify(other))
    assert.deepEqual(pendingRecipe(workspace), other)
    assert.deepEqual(pendingRecipe(origin), draft)
  } finally {
    if (previous) Object.defineProperty(globalThis, 'sessionStorage', previous)
    else delete globalThis.sessionStorage
  }
})

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

const deletionFixture = async ({ shared = false, sandbox = false, source, image = 'openshell-template/test:one', dockerError, listError, absent = false } = {}) => {
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
      return { sandboxes: sandbox ? [{ metadata: { name: 'sandbox-1' }, createdFromWorkloadTemplate: source ? { name: source } : undefined, phase: 'stopped', spec: { template: { image } } }] : [] }
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

test('images shared with other templates and their sandboxes are retained explicitly', async () => {
  for (const options of [{ shared: true }, { sandbox: true, source: 'other' }]) {
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


test('existing sandbox usage blocks deletion before Docker or template mutation, including older builds', async () => {
  for (const options of [{ sandbox: true }, { sandbox: true, source: 'test', image: 'old-build' }]) {
    const { operation, calls } = await deletionFixture(options)
    await assert.rejects(operation(), (error) => {
      assert.equal(error.status, 409)
      assert.equal(error.code, 'TEMPLATE_IN_USE')
      assert.deepEqual(error.sandboxes, [{ name: 'sandbox-1' }])
      return true
    })
    assert.deepEqual(calls, [])
  }
})

test('usage returns every blocker across pages and permits deletion once they are removed', async () => {
  const { imageTemplateUsage, deleteImageTemplate } = await import('./image-templates.js')
  let sandboxes = [
    { metadata: { name: 'running', labels: { 'openshell.console/image-template-name': 'test' } } },
    { metadata: { name: 'stopped' }, createdFromWorkloadTemplate: { name: 'test' } },
  ]
  const calls = []
  const client = {
    raw: { listSandboxes: async ({ pageToken }) => ({ sandboxes: sandboxes.slice(pageToken ? 1 : 0, pageToken ? 2 : 1), nextPageToken: pageToken ? '' : 'next' }) },
    sandboxTemplates: { get: async () => ({}), delete: async () => calls.push('delete') },
  }
  assert.deepEqual((await imageTemplateUsage(client, 'test')).sandboxes, [{ name: 'running' }, { name: 'stopped' }])
  await assert.rejects(deleteImageTemplate(client, 'test'), { code: 'TEMPLATE_IN_USE' })
  sandboxes = []
  assert.equal((await deleteImageTemplate(client, 'test')).ok, true)
  assert.deepEqual(calls, ['delete'])
})

function publicationFixture({ local = false, recipe = newRecipe({ name: 'app', agents: [], setup: 'printf ready' }), setups = [], replace = false, saveError, loadError, loadedPatch, builtPatch, createError, after, changedEngine = false } = {}) {
  const buildEngine = { endpoint: 'unix:///local-docker.sock', architecture: 'arm64', engineId: 'local-engine' }
  const engine = local ? buildEngine : { endpoint: 'unix:///ssh-docker.sock', architecture: 'amd64', engineId: 'remote-engine' }
  const oldImage = 'openshell-template/app:previous'
  const previous = replace ? { metadata: { name: 'app' }, spec: { workload: { image: oldImage } } } : null
  const stores = new Map([buildEngine, engine].map(value => [value.endpoint, new Map([
    ['unrelated:latest', { Id: 'sha256:unrelated', Os: 'linux', Architecture: value.architecture }],
    [oldImage, { Id: 'sha256:previous', Os: 'linux', Architecture: value.architecture }],
  ])]))
  const templates = new Map(previous ? [['origin/app', previous]] : [])
  const events = []
  const files = {}
  const job = { cancelled: false, logs: '' }
  const client = { sandboxTemplates: {
    delete: async (name, { workspace }) => {
      events.push({ kind: 'delete', workspace })
      templates.delete(`${workspace}/${name}`)
    },
    create: async (template, { workspace }) => {
      events.push({ kind: 'create', workspace, context: contextKey() })
      if (createError && template.spec.workload.image !== oldImage) throw new Error(createError)
      templates.set(`${workspace}/${template.metadata.name}`, template)
    },
  } }
  const input = { recipe, setups, client, workspace: 'origin', previous, target: { remote: !local, name: 'ssh-origin' }, engine, buildEngine, job }
  const execute = async (args, { engine: selected, job: runningJob } = {}) => {
    if (runningJob?.cancelled) throw new Error('Operation cancelled.')
    const store = stores.get(selected.endpoint)
    assert.ok(store, `Unknown Docker engine: ${selected.endpoint}`)
    const findImage = reference => store.get(reference) ?? [...store.values()].find(image => image.Id === reference)
    const kind = args[0] === 'image' ? args[1] : args[0]
    const event = { kind, args, endpoint: selected.endpoint }
    events.push(event)
    let output = ''
    if (kind === 'build') {
      files.context = args.at(-1)
      files.dockerfile = await fs.readFile(path.join(files.context, 'Dockerfile'), 'utf8')
      files.contextEntries = await fs.readdir(files.context)
      if (recipe.source === 'image' && setups.length) {
        files.baseReference = files.dockerfile.match(/^FROM (\S+)/)[1]
        files.baseImage = findImage(files.baseReference)
        assert.ok(files.baseImage, 'The setup build requires its base image on the local builder')
      }
      files.setup = await fs.readFile(path.join(files.context, 'setup.sh'), 'utf8')
      files.bundles = new Map()
      for (const entry of await fs.readdir(path.join(files.context, 'setup-bundles')).catch(error => { if (error.code === 'ENOENT') return []; throw error })) {
        files.bundles.set(entry, await fs.readFile(path.join(files.context, 'setup-bundles', entry)))
      }
      const image = args[args.indexOf('--tag') + 1]
      const platform = args.includes('--platform') ? args[args.indexOf('--platform') + 1] : process.env.DOCKER_DEFAULT_PLATFORM
      store.set(image, { Id: 'sha256:generated', Os: platform.split('/')[0], Architecture: platform.split('/')[1], ...builtPatch })
      files.image = image
    } else if (kind === 'inspect') {
      const image = findImage(args.at(-1))
      if (!image) throw new Error(`No such image: ${args.at(-1)}`)
      output = JSON.stringify([image])
    } else if (kind === 'save') {
      if (saveError) throw new Error(saveError)
      files.archive = args[args.indexOf('--output') + 1]
      const image = args.at(-1)
      const data = findImage(image)
      assert.ok(data)
      if (selected.endpoint === input.engine.endpoint && !local) files.baseArchive = files.archive
      await fs.writeFile(files.archive, JSON.stringify({ image, data }))
    } else if (kind === 'load') {
      if (loadError) throw new Error(loadError)
      const { image, data } = JSON.parse(await fs.readFile(args[args.indexOf('--input') + 1], 'utf8'))
      store.set(image, { ...data, ...loadedPatch })
    } else if (kind === 'info') {
      output = JSON.stringify({ ID: changedEngine ? 'other-engine' : selected.engineId })
    } else if (kind === 'pull') {
      const platform = args[args.indexOf('--platform') + 1]
      store.set(args.at(-1), { Id: 'sha256:pulled', Os: platform.split('/')[0], Architecture: platform.split('/')[1] })
    } else if (kind === 'tag') {
      const image = findImage(args[1])
      assert.ok(image)
      store.set(args[2], image)
    } else if (kind === 'rm') {
      store.delete(args.at(-1))
    } else assert.fail(`Unexpected Docker command: ${args.join(' ')}`)
    if (after) await after(event, input)
    return output
  }
  return { input, events, files, stores, templates, operation: () => publishImageTemplate(input, { execute }) }
}

test('SSH images build locally for remote architecture, transfer only their tag, and publish after verification', async () => {
  const previousPlatform = process.env.DOCKER_DEFAULT_PLATFORM
  process.env.DOCKER_DEFAULT_PLATFORM = 'linux/arm64'
  try {
    const fixture = publicationFixture({ replace: true })
    const image = await fixture.operation()
    const { input, events, files, stores, templates } = fixture
    assert.equal(stores.get(input.buildEngine.endpoint).get(image).Architecture, 'amd64')
    assert.deepEqual(stores.get(input.engine.endpoint).get(image), stores.get(input.buildEngine.endpoint).get(image))
    assert.equal(templates.get('origin/app').spec.workload.image, image)
    assert.deepEqual(events.map(event => event.kind), ['build', 'inspect', 'save', 'info', 'load', 'inspect', 'delete', 'create'])
    assert.equal(events[0].endpoint, input.buildEngine.endpoint)
    assert.deepEqual(events[2].args, ['save', '--output', files.archive, image])
    assert.equal(events[4].endpoint, input.engine.endpoint)
    assert.deepEqual(events[4].args, ['load', '--input', files.archive])
    for (const store of stores.values()) {
      assert.equal(store.get('unrelated:latest').Id, 'sha256:unrelated')
      assert.equal(store.get('openshell-template/app:previous').Id, 'sha256:previous')
    }
    assert.equal(files.setup, 'printf ready')
    await assert.rejects(fs.access(files.context), { code: 'ENOENT' })
  } finally {
    if (previousPlatform === undefined) delete process.env.DOCKER_DEFAULT_PLATFORM
    else process.env.DOCKER_DEFAULT_PLATFORM = previousPlatform
  }
})

test('local and worker builds keep their native platform without exporting or loading', async () => {
  const fixture = publicationFixture({ local: true })
  const image = await fixture.operation()
  assert.equal(fixture.stores.get(fixture.input.engine.endpoint).get(image).Architecture, 'arm64')
  assert.equal(fixture.templates.get('origin/app').spec.workload.image, image)
  assert.deepEqual(fixture.events.map(event => event.kind), ['build', 'inspect', 'create'])
})

test('failed transfers and mismatched loaded images preserve the previous template and remove the archive', async () => {
  for (const options of [
    { saveError: 'No space left on device' },
    { loadError: 'SSH tunnel closed' },
    { loadedPatch: { Id: 'sha256:other' } },
    { loadedPatch: { Architecture: 'arm64' } },
    { loadedPatch: { Os: 'windows' } },
    { builtPatch: { Architecture: 'arm64' } },
    { builtPatch: { Id: undefined } },
    { changedEngine: true },
  ]) {
    const fixture = publicationFixture({ replace: true, ...options })
    await assert.rejects(fixture.operation())
    assert.equal(fixture.templates.get('origin/app'), fixture.input.previous)
    assert.equal(fixture.events.some(event => ['create', 'delete', 'rm'].includes(event.kind)), false)
    if (options.changedEngine || options.saveError) assert.equal(fixture.events.some(event => event.kind === 'load'), false)
    await assert.rejects(fs.access(fixture.files.context), { code: 'ENOENT' })
  }
})

test('cancellation throughout build and transfer never publishes or deletes an existing template', async () => {
  for (const stage of ['build', 'save', 'load', 'verify']) {
    const fixture = publicationFixture({ replace: true, after: (event, input) => {
      if (event.kind === stage || (stage === 'verify' && event.kind === 'inspect' && event.endpoint === input.engine.endpoint)) input.job.cancelled = true
    } })
    await assert.rejects(fixture.operation(), /cancelled/)
    assert.equal(fixture.templates.get('origin/app'), fixture.input.previous)
    assert.equal(fixture.events.some(event => ['create', 'delete', 'rm'].includes(event.kind)), false)
    await assert.rejects(fs.access(fixture.files.context), { code: 'ENOENT' })
  }
})

test('failed registration restores the previous template and only removes the generated local tag', async () => {
  const fixture = publicationFixture({ replace: true, createError: 'Gateway unavailable' })
  await assert.rejects(fixture.operation(), /Gateway unavailable/)
  assert.equal(fixture.templates.get('origin/app').spec.workload.image, fixture.input.previous.spec.workload.image)
  assert.deepEqual(fixture.events.filter(event => event.kind === 'rm').map(event => [event.endpoint, event.args]), [
    [fixture.input.buildEngine.endpoint, ['image', 'rm', '--', fixture.files.image]],
  ])
  assert.equal(fixture.stores.get(fixture.input.engine.endpoint).get(fixture.files.image).Id, 'sha256:generated')
  assert.equal(fixture.stores.get(fixture.input.buildEngine.endpoint).get('unrelated:latest').Id, 'sha256:unrelated')
  await assert.rejects(fs.access(fixture.files.context), { code: 'ENOENT' })
})

test('image references inspect or pull on the selected deployment engine without building locally', async () => {
  for (const present of [false, true]) {
    const fixture = publicationFixture({ recipe: newRecipe({ name: 'app', source: 'image', image: 'example/app:1' }) })
    fixture.stores.delete(fixture.input.buildEngine.endpoint)
    if (present) fixture.stores.get(fixture.input.engine.endpoint).set('example/app:1', { Id: 'sha256:existing', Os: 'linux', Architecture: 'amd64' })
    const image = await fixture.operation()
    assert.equal(image, 'example/app:1')
    assert.equal(fixture.stores.get(fixture.input.engine.endpoint).get(image).Architecture, 'amd64')
    assert.equal(fixture.templates.get('origin/app').spec.workload.image, image)
    assert.equal(fixture.events.filter(event => event.kind === 'pull').length, present ? 0 : 1)
    assert.equal(fixture.events.some(event => ['build', 'save', 'load'].includes(event.kind)), false)
    assert.equal(fixture.events.filter(event => event.endpoint).every(event => event.endpoint === fixture.input.engine.endpoint), true)
  }
})

test('an existing reference with the wrong platform is not published or removed', async () => {
  const fixture = publicationFixture({ recipe: newRecipe({ name: 'app', source: 'image', image: 'example/app:1' }) })
  fixture.stores.get(fixture.input.engine.endpoint).set('example/app:1', { Id: 'sha256:wrong-platform', Os: 'linux', Architecture: 'arm64' })
  await assert.rejects(fixture.operation(), /deployment engine/)
  assert.equal(fixture.templates.has('origin/app'), false)
  assert.equal(fixture.stores.get(fixture.input.engine.endpoint).get('example/app:1').Id, 'sha256:wrong-platform')
  assert.equal(fixture.events.some(event => ['pull', 'rm'].includes(event.kind)), false)
})

test('setup image layers preserve prepared artifacts and remain bound to the originating context', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'image-setup-test-'))
  const previousDirectory = process.env.OPENSHELL_CONSOLE_DATA_DIR
  process.env.OPENSHELL_CONSOLE_DATA_DIR = directory
  try {
    const origin = { gateway: 'ssh-origin', workspace: 'origin' }
    const payload = Buffer.from('prepared package bytes')
    const digest = createHash('sha256').update(payload).digest('hex')
    const setup = { id: 'a'.repeat(24), revision: 'one', items: [{ artifact: { digest } }] }
    const fixture = publicationFixture({
      recipe: newRecipe({ name: 'app', source: 'image', image: 'example/app:1' }),
      setups: [setup],
      after: async event => {
        if (event.kind === 'load') await runWithContext({ gateway: 'different', workspace: 'other' }, async () => {
          await Promise.resolve()
          assert.equal(contextKey(), '["different","other"]')
        })
      },
    })
    await runWithContext(origin, async () => {
      const artifacts = path.join(scopedStateDirectory(), 'setup-artifacts')
      await fs.mkdir(artifacts, { recursive: true })
      await fs.writeFile(path.join(artifacts, digest + '.tar.gz'), payload)
      await fixture.operation()
    })
    assert.equal(fixture.files.baseImage.Id, 'sha256:pulled')
    assert.deepEqual(JSON.parse(fixture.files.bundles.get(setup.id + '.json')), setup)
    assert.deepEqual(fixture.files.bundles.get(digest + '.tar.gz'), payload)
    assert.equal(fixture.events.find(event => event.kind === 'build').args.includes('--network=none'), true)
    assert.deepEqual(fixture.events.find(event => event.kind === 'create'), { kind: 'create', workspace: 'origin', context: '["ssh-origin","origin"]' })
  } finally {
    if (previousDirectory === undefined) delete process.env.OPENSHELL_CONSOLE_DATA_DIR
    else process.env.OPENSHELL_CONSOLE_DATA_DIR = previousDirectory
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('local Docker discovery is independent of selected SSH compute and unavailable Docker is actionable', async () => {
  const previousHost = process.env.DOCKER_HOST
  delete process.env.DOCKER_HOST
  try {
    const engine = await runWithContext({ gateway: 'ssh-without-local-registration', workspace: 'origin' }, () => localEngine({ execute: async args => {
      if (args[0] === 'context') return JSON.stringify([{ Endpoints: { docker: { Host: 'unix:///local.sock' } } }])
      return JSON.stringify({ OSType: 'linux', Architecture: 'aarch64', ID: 'local-engine' })
    } }))
    assert.equal(engine.endpoint, 'unix:///local.sock')
    assert.equal(engine.architecture, 'arm64')
    await assert.rejects(localEngine({ execute: async () => { throw new Error('Docker daemon is stopped') } }), /Local Docker is required.*Install or start Docker/)
  } finally {
    if (previousHost === undefined) delete process.env.DOCKER_HOST
    else process.env.DOCKER_HOST = previousHost
  }
})

test('a Docker context pointing at the SSH deployment engine cannot be used to build remotely', async () => {
  const fixture = publicationFixture()
  fixture.input.buildEngine = { ...fixture.input.engine, endpoint: 'unix:///other-tunnel-to-same-engine.sock' }
  await assert.rejects(fixture.operation(), /Select a local Docker context/)
  assert.deepEqual(fixture.events, [])
})

test('remote-only setup bases are imported by ID without overwriting a local image with the same name', async () => {
  for (const collision of [false, true]) {
    const reference = 'example/private-base:1'
    const fixture = publicationFixture({
      recipe: newRecipe({ name: 'app', source: 'image', image: reference }),
      setups: [{ id: 'b'.repeat(24), revision: 'one', items: [{ id: 'remote-mcp', kind: 'mcp', issues: [], config: { url: 'https://example.com/mcp' } }] }],
    })
    const local = fixture.stores.get(fixture.input.buildEngine.endpoint)
    const remote = fixture.stores.get(fixture.input.engine.endpoint)
    const remoteBase = { Id: 'sha256:remote-base', Os: 'linux', Architecture: 'amd64' }
    const localBase = { Id: 'sha256:local-base', Os: 'linux', Architecture: 'arm64' }
    remote.set(reference, remoteBase)
    if (collision) local.set(reference, localBase)
    const image = await fixture.operation()
    assert.equal(fixture.files.baseImage.Id, remoteBase.Id)
    assert.equal(remote.get(reference), remoteBase)
    assert.equal(local.get(reference), collision ? localBase : undefined)
    assert.equal(remote.get(image).Id, 'sha256:generated')
    const exportedBase = fixture.events.find(event => event.kind === 'save' && event.endpoint === fixture.input.engine.endpoint)
    assert.deepEqual(exportedBase.args, ['save', '--output', fixture.files.baseArchive, remoteBase.Id])
    assert.equal(fixture.events.some(event => event.kind === 'pull'), false)
    assert.notEqual(fixture.files.baseReference, reference)
    assert.equal(local.has(fixture.files.baseReference), false)
    assert.equal(fixture.files.contextEntries.includes('base.tar'), false)
    assert.deepEqual(fixture.events.filter(event => event.kind === 'rm').map(event => [event.endpoint, event.args.at(-1)]), [
      [fixture.input.buildEngine.endpoint, fixture.files.baseReference],
    ])
    await assert.rejects(fs.access(fixture.files.baseArchive), { code: 'ENOENT' })
  }
})

test('local setup layers use the existing base directly without importing or retagging it', async () => {
  const reference = 'example/local-base:1'
  const fixture = publicationFixture({
    local: true,
    recipe: newRecipe({ name: 'app', source: 'image', image: reference }),
    setups: [{ id: 'b'.repeat(24), revision: 'one', items: [{ id: 'local-mcp', kind: 'mcp', issues: [], config: { url: 'https://example.com/mcp' } }] }],
  })
  const base = { Id: 'sha256:local-base', Os: 'linux', Architecture: 'arm64' }
  const local = fixture.stores.get(fixture.input.buildEngine.endpoint)
  local.set(reference, base)
  await fixture.operation()
  assert.equal(fixture.files.baseReference, reference)
  assert.equal(fixture.files.baseImage, base)
  assert.equal(local.get(reference), base)
  assert.equal(fixture.events.some(event => ['save', 'load', 'tag', 'rm', 'pull'].includes(event.kind)), false)
})

test('invalid imported setup bases and interrupted builds preserve user tags and clean temporary base tags', async () => {
  for (const [options, error] of [
    [{ loadedPatch: { Id: 'sha256:wrong-base' } }, /does not match/],
    [{ loadedPatch: { Architecture: 'arm64' } }, /deployment engine/],
    [{ after: (event, input) => { if (event.kind === 'tag') input.job.cancelled = true } }, /cancelled/],
    [{ after: event => { if (event.kind === 'build') throw new Error('Fixture build failed') } }, /build failed/],
  ]) {
    const reference = 'example/private-base:1'
    const fixture = publicationFixture({
      ...options,
      replace: true,
      recipe: newRecipe({ name: 'app', source: 'image', image: reference }),
      setups: [{ id: 'b'.repeat(24), revision: 'one', items: [{ id: 'remote-mcp', kind: 'mcp', issues: [], config: { url: 'https://example.com/mcp' } }] }],
    })
    const local = fixture.stores.get(fixture.input.buildEngine.endpoint)
    const remote = fixture.stores.get(fixture.input.engine.endpoint)
    const remoteBase = { Id: 'sha256:remote-base', Os: 'linux', Architecture: 'amd64' }
    const localBase = { Id: 'sha256:local-base', Os: 'linux', Architecture: 'arm64' }
    remote.set(reference, remoteBase)
    local.set(reference, localBase)
    await assert.rejects(fixture.operation(), error)
    assert.equal(remote.get(reference), remoteBase)
    assert.equal(local.get(reference), localBase)
    assert.equal(fixture.templates.get('origin/app'), fixture.input.previous)
    assert.equal(fixture.events.some(event => ['create', 'delete'].includes(event.kind)), false)
    assert.equal([...local.keys()].some(tag => tag.startsWith('openshell-template/app:base-')), false)
    for (const event of fixture.events.filter(event => event.kind === 'rm')) {
      assert.equal(event.endpoint, fixture.input.buildEngine.endpoint)
      assert.match(event.args.at(-1), /^openshell-template\/app:base-/)
    }
    await assert.rejects(fs.access(fixture.files.baseArchive), { code: 'ENOENT' })
  }
})
