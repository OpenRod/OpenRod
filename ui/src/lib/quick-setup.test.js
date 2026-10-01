import test from 'node:test'
import assert from 'node:assert/strict'
import { QUICK_AGENTS, quickRecipe, matchingQuickTemplate, compatibleProviders, prepareQuickTemplate } from './quick-setup.js'
import { recipeErrors, dockerfileFor, buildFingerprint } from './image-templates.js'
import { agentAccessRules } from '../../shared/agent-access.js'

const withBuild = (item) => ({ ...item, build: buildFingerprint(item.recipe) })
const ready = (id, changes = {}) => withBuild({ name: 'saved', managed: true, image: 'local:test', status: 'ready', recipe: quickRecipe(id, 'saved'), ...changes })
test('every offered agent has a valid install recipe and reviewed access rules', () => {
  for (const id of [...QUICK_AGENTS.map((a) => a.id), 'terminal']) {
    const recipe = quickRecipe(id, 'quick-test')
    assert.deepEqual(recipeErrors(recipe), {})
    assert.equal(recipe.agents.length, id === 'terminal' ? 0 : 1)
    assert.equal(agentAccessRules(recipe).length, recipe.agents.length)
    assert.match(dockerfileFor(recipe), /USER sandbox/)
  }
  assert.throws(() => quickRecipe('not-supported'), /supported/)
})
test('reuse requires exact recipe, including environment, extra agents and setup commands', () => {
  const valid = ready('codex')
  assert.equal(matchingQuickTemplate([valid], 'codex'), valid)
  for (const recipe of [
    { ...valid.recipe, agents: ['codex', 'claude'] },
    { ...valid.recipe, setup: 'touch /tmp/extra' },
    { ...valid.recipe, environment: [{ name: 'MODE', value: 'changed' }] },
  ]) assert.equal(matchingQuickTemplate([ready('codex', { recipe })], 'codex'), undefined)
  assert.equal(matchingQuickTemplate([ready('codex', { managed: false })], 'codex'), undefined)
  assert.equal(matchingQuickTemplate([ready('codex', { status: 'building' })], 'codex'), undefined)
  // Images built before the console changed how an agent installs are rebuilt.
  assert.equal(matchingQuickTemplate([{ ...ready('codex'), build: null }], 'codex'), undefined)
  assert.equal(matchingQuickTemplate([{ ...ready('codex'), build: '00000000' }], 'codex'), undefined)
})
test('saved credential matching does not treat a network profile as sign-in', () => {
  const providers = [{ name: 'network', type: 'cursor' }, { name: 'claude', type: 'claude-code' }, { name: 'codex', type: 'codex' }]
  assert.deepEqual(compatibleProviders(providers, 'cursor'), [])
  assert.deepEqual(compatibleProviders(providers, 'codex').map((p) => p.name), ['codex'])
})
test('reuse returns without starting a build', async () => {
  const item = ready('codex')
  const result = await prepareQuickTemplate({ imageTemplates: async () => [item], buildImageTemplate: () => assert.fail('unexpected build') }, 'codex')
  assert.equal(result, item)
})
test('preparation waits for build readiness before returning', async () => {
  let recipe, polls = 0
  const api = {
    imageTemplates: async () => recipe ? [withBuild({ ...ready('codex'), name: recipe.name, recipe, status: ++polls > 1 ? 'ready' : 'building' })] : [],
    buildImageTemplate: async (value) => { recipe = value; return { status: 'building' } },
  }
  const result = await prepareQuickTemplate(api, 'codex', { wait: async () => {} })
  assert.equal(result.status, 'ready')
  assert.equal(polls, 2)
  assert.deepEqual(recipeErrors(recipe), {})
})
test('build failures and cancellation never return a launchable template', async () => {
  let name
  const api = {
    imageTemplates: async () => name ? [{ name, status: 'failed', error: 'Docker build failed' }] : [],
    buildImageTemplate: async (recipe) => { name = recipe.name; return { status: 'building' } },
  }
  await assert.rejects(prepareQuickTemplate(api, 'terminal', { wait: async () => {} }), /Docker build failed/)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(prepareQuickTemplate({ imageTemplates: () => assert.fail('unexpected request') }, 'codex', { signal: controller.signal }), { name: 'AbortError' })
})
test('cancellation while a build starts cannot continue into readiness', async () => {
  const controller = new AbortController()
  let tracked
  await assert.rejects(prepareQuickTemplate({
    imageTemplates: async () => [],
    buildImageTemplate: async () => { controller.abort(); return { status: 'building' } },
  }, 'codex', { signal: controller.signal, onBuild: (name) => { tracked = name }, wait: () => assert.fail('must not poll') }), { name: 'AbortError' })
  assert.match(tracked, /^q-codex-/)
})
test('Shell startup keeps the selected agent installed and does not reuse agent startup', async () => {
  for (const agent of QUICK_AGENTS) {
    const shell = quickRecipe(agent.id, 'shell-test', 'shell')
    assert.deepEqual(shell.agents, [agent.id])
    assert.equal(shell.command, '')
    assert.equal(quickRecipe(agent.id).command, agent.command)
    assert.equal(dockerfileFor(shell), dockerfileFor(quickRecipe(agent.id, 'shell-test')))
  }
  assert.equal(matchingQuickTemplate([ready('codex')], 'codex', 'shell'), undefined)
  let built
  const api = {
    imageTemplates: async () => built ? [ready('codex', { name: built.name, recipe: built })] : [ready('codex')],
    buildImageTemplate: async (recipe) => { built = recipe; return { status: 'building' } },
  }
  const result = await prepareQuickTemplate(api, 'codex', { openIn: 'shell', wait: async () => {} })
  assert.equal(result.recipe.command, '')
  assert.deepEqual(result.recipe.agents, ['codex'])
  assert.throws(() => quickRecipe('codex', '', 'custom'), /Choose Shell/)
})
test('composed recipes deduplicate and normalize selection order for reuse', () => {
  const recipe = quickRecipe(['codex', 'claude', 'codex'], 'multi')
  assert.deepEqual(recipe.agents, ['claude', 'codex'])
  assert.equal(recipe.command, '')
  assert.deepEqual(recipeErrors(recipe), {})
  const saved = withBuild({ name: 'multi', managed: true, image: 'local:multi', status: 'ready', recipe })
  assert.equal(matchingQuickTemplate([saved], ['claude', 'codex']), saved)
  assert.equal(matchingQuickTemplate([saved], ['codex']), undefined)
  assert.equal(agentAccessRules(recipe).length, 2)
  assert.match(dockerfileFor(recipe), /@openai\/codex/)
  assert.match(dockerfileFor(recipe), /install-claude/)
})
test('session selection is separate from composed images and validates installed agents', async () => {
  const { quickSession } = await import('./quick-setup.js')
  const { templateSession, sessionLaunch } = await import('./sandbox-session.js')
  const saved = { managed: true, recipe: quickRecipe(['codex', 'cursor']) }
  for (const id of ['shell', 'codex', 'cursor']) {
    const session = quickSession(['codex', 'cursor'], id)
    assert.equal(session, 'shell')
    assert.equal(templateSession(saved, session), session)
    assert.deepEqual(sessionLaunch(session, []).command, ['/bin/sleep', 'infinity'])
  }
  assert.equal(quickSession(['cursor'], 'cursor'), 'cursor-agent')
  assert.throws(() => quickSession(['codex'], 'claude'), /selected agent/)
  assert.throws(() => templateSession(saved, 'claude'), /included/)
  assert.throws(() => templateSession({ ...saved, managed: false }, 'codex'), /included/)
  assert.equal(templateSession(saved, undefined), 'shell')
  assert.deepEqual(quickRecipe([]).agents, [])
  assert.equal(quickSession([], 'shell'), 'shell')
})

test('adding a second agent overrides any previous agent session with Shell', async () => {
  const { quickSession } = await import('./quick-setup.js')
  assert.equal(quickSession(['codex'], 'codex'), 'codex')
  assert.equal(quickSession(['codex', 'claude'], 'codex'), 'shell')
  assert.equal(quickSession(['codex', 'claude'], 'claude'), 'shell')
  assert.equal(quickSession(['codex', 'claude'], 'shell'), 'shell')
  assert.equal(quickSession(['codex'], 'shell'), 'shell')
})

test('quick setup attachments require an image with Python without baking private snapshots into shared templates', async () => {
  const withoutPython = ready(['codex'])
  assert.equal(matchingQuickTemplate([withoutPython], ['codex'], 'agent', true), undefined)
  const prepared = withBuild({ ...ready(['codex']), recipe: quickRecipe(['codex'], 'saved', 'agent', true) })
  assert.equal(matchingQuickTemplate([prepared], ['codex'], 'agent', true), prepared)
  let built
  const api = {
    imageTemplates: async () => built ? [{ name: built.name, status: 'ready', recipe: built, image: 'test:image' }] : [withoutPython],
    buildImageTemplate: async (recipe) => { built = recipe; return { status: 'building' } },
  }
  await prepareQuickTemplate(api, ['codex'], { withSetups: true, wait: async () => {} })
  assert.deepEqual(built.runtimes, ['python', 'node'])
  assert.deepEqual(built.setups, [])
  assert.match(dockerfileFor(built), /python3/)
})

test('Quick setup pins selected Setups into the image and never reuses a different revision', async () => {
  const setups=[{id:'a'.repeat(24),revision:'b'.repeat(64)}]
  const recipe=quickRecipe(['codex'],'with-mcp','agent',true,setups)
  assert.deepEqual(recipe.setups,[setups[0].id])
  assert.deepEqual(recipe.setupRevisions,{[setups[0].id]:setups[0].revision})
  assert.match(dockerfileFor(recipe),/COPY --chown=1000:1000 setup-bundles/)
  assert.deepEqual(recipeErrors(recipe),{})
  const image=ready(['codex'],{recipe})
  assert.equal(matchingQuickTemplate([image],['codex'],'agent',true,setups),image)
  assert.equal(matchingQuickTemplate([image],['codex'],'agent',true,[{...setups[0],revision:'c'.repeat(64)}]),undefined)
})
test('package preparation remaps reviewed access to the prepared snapshot and reports progress', async () => {
  const {prepareQuickSetups}=await import('./quick-setup.js')
  const source={id:'source',revision:'old',name:'My tools'}, prepared={id:'pinned',revision:'new'}
  const progress=[]
  const result=await prepareQuickSetups({
    setups:async()=>[source],
    prepareLaunchSetup:async(id,revision)=>{assert.equal(id,'source');assert.equal(revision,'old');return {id:'job',status:'running',message:'Installing shadcn'}},
    setupPreparation:async()=>({status:'complete',setup:prepared}),
  },['source'],{source:'old'},{wait:async()=>{},onProgress:s=>progress.push(s)})
  assert.deepEqual(result,{setups:[prepared],accessReview:{pinned:'new'}})
  assert.ok(progress.includes('Installing shadcn'))
})
test('failed or cancelled MCP preparation cannot proceed to image creation', async () => {
  const {prepareQuickSetups}=await import('./quick-setup.js')
  const source={id:'source',revision:'old',name:'My tools'}
  const base={setups:async()=>[source],prepareLaunchSetup:async()=>({id:'job',status:'running'}),setupPreparation:async()=>({status:'failed',message:'shadcn: registry blocked'})}
  await assert.rejects(prepareQuickSetups(base,['source'],null,{wait:async()=>{}}),/registry blocked/)
  const controller=new AbortController();let cancelled
  await assert.rejects(prepareQuickSetups({...base,cancelSetupPreparation:async id=>{cancelled=id}},['source'],null,{signal:controller.signal,wait:async()=>controller.abort()}),{name:'AbortError'})
  assert.equal(cancelled,'job')
  await assert.rejects(prepareQuickSetups(base,['source'],{source:'changed'}),/changed/)
})
test('automatic package eligibility excludes credentials, disabled and unsupported dependencies', async () => {
  const {canPrepareAtLaunch,launchRequirements}=await import('../../shared/setup-launch.js')
  const item={package:{name:'shadcn'},issues:['Prepare package dependencies in the next step.'],requirements:[]}
  assert.equal(canPrepareAtLaunch(item),true)
  assert.equal(canPrepareAtLaunch({...item,issues:['Registry failed'],preparationIssues:['Registry failed']}),true)
  for(const change of [{disabled:true},{credentialFields:['TOKEN']},{issues:['Local executable needs packaging']},{artifact:{digest:'already-prepared'}}]) assert.equal(canPrepareAtLaunch({...item,...change}),false)
  assert.ok(launchRequirements(item).some(r=>r.host==='ui.shadcn.com'&&r.phase==='runtime'))
})

test('launch rejects unprepared packages instead of silently omitting them', async () => {
 const {assertPackagesPrepared}=await import('../../shared/setup-launch.js')
 const item={name:'shadcn',package:{name:'shadcn'},issues:['Prepare package dependencies in the next step.']}
 assert.throws(()=>assertPackagesPrepared([{items:[item]}]),/shadcn.*No sandbox was created/)
 assert.doesNotThrow(()=>assertPackagesPrepared([{items:[{...item,artifact:{digest:'pinned'},issues:[]}]}]))
})


test('build updates expose initial, growing, and failed logs before rejecting launch', async () => {
  let name, polls = 0
  const updates = []
  const api = {
    imageTemplates: async () => name ? [{ name, status: ++polls === 1 ? 'building' : 'failed', logs: polls === 1 ? 'Step 1\nStep 2' : 'Step 1\nStep 2\nInstall failed', error: polls > 1 ? 'Install failed' : null }] : [],
    buildImageTemplate: async (recipe) => { name = recipe.name; return { status: 'building', logs: 'Step 1' } },
  }
  await assert.rejects(prepareQuickTemplate(api, 'terminal', { wait: async () => {}, onBuildUpdate: (value) => updates.push(value) }), /Install failed/)
  assert.deepEqual(updates.map((value) => value.logs), ['Step 1', 'Step 1\nStep 2', 'Step 1\nStep 2\nInstall failed'])
  assert.ok(updates.every((value) => value.name === name))
})
