import test from 'node:test'
import assert from 'node:assert/strict'
import { createAnalytics, sanitizeEvent, classifyAnalyticsError, USAGE_KEY } from './analytics.js'
import { createSandboxCreations } from './sandbox-creations.js'

const tick = () => new Promise(resolve => setImmediate(resolve))
function harness(options = {}) {
  const data = new Map(), calls = [], timers = new Map()
  let time = 1800000000000, sequence = 0, timerId = 0
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) }
  const config = { enabled: true, projectToken: 'phc_test', host: 'https://us.i.posthog.com', version: '0.1.2', environment: 'production', ...options.config }
  const client = createAnalytics({ config, getStorage: options.getStorage ?? (() => storage),
    getLocation: options.getLocation ?? (() => 'http://127.0.0.1:4600/#sandboxes'),
    randomUUID: () => `${(++sequence).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`, now: () => time,
    fetch: (url, init) => { calls.push({ url, init, event: JSON.parse(init.body) }); return options.send?.(url, init) ?? Promise.resolve({ ok: true }) },
    setTimer: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, at: time + delay }); return id }, clearTimer: id => timers.delete(id),
  })
  return { client, data, calls, storage, configure: () => client.configure({ mode: 'local', enabled: true }),
    enable() { this.configure(); client.setSharing(true) },
    advance(ms) { time += ms; for (const [id, timer] of [...timers]) if (timer.at <= time) { timers.delete(id); timer.fn() } },
  }
}

test('nothing is transmitted or identified before authorization and opt-in', async () => {
  const h = harness()
  h.client.capture('view_opened', { view: 'secrets' })
  assert.equal(h.data.size, 0)
  h.configure(); h.client.observeView('secrets'); h.client.observeConsole('live')
  assert.equal(h.calls.length, 0)
  h.client.setSharing(false); h.client.capture('view_opened')
  assert.equal(h.calls.length, 0)
  h.client.setSharing(true); h.client.observeView('secrets'); h.client.observeConsole('live')
  assert.deepEqual(h.calls.map(call => call.event.event), ['view_opened', 'console_opened'])
  assert.equal(h.calls[1].event.properties.first_observed_visit, true) // view capture must not hide a fresh visit
  await tick()
})

test('runtime disable, missing token, invalid host, development and sensitive URLs fail closed', () => {
  for (const options of [ { config: { projectToken: '' } }, { config: { host: 'https://untrusted.example' } },
    { config: { enabled: false } }, { getLocation: () => 'http://localhost/?token=private' },
    { getLocation: () => 'http://localhost/?handoff=private' }, { getLocation: () => 'http://localhost/#local-connect=private' },
    { getLocation: () => { throw Error('blocked') } }, { config: { environment: 'development' }, getLocation: () => 'http://localhost/?fleet=100' },
  ]) {
    const h = harness(options); h.enable(); h.client.capture('console_opened'); h.client.submitFeedback({ prompt: 'general', text: 'explicit' })
    assert.equal(h.calls.length, 0)
  }
  const h = harness(); h.enable(); h.client.configure({ enabled: false }); h.client.capture('view_opened'); assert.equal(h.calls.length, 0)
  h.client.configure({ enabled: true, mode: 'cloud' }); h.client.capture('view_opened'); assert.equal(h.calls.length, 0)
})

test('storage denial fails silently and does not invent consent', () => {
  const h = harness({ getStorage: () => { throw Error('storage denied') } })
  assert.doesNotThrow(() => { h.enable(); h.client.capture('view_opened'); h.client.submitFeedback({ text: 'hello' }) })
  assert.equal(h.calls.length, 0)
  assert.equal(h.client.getSnapshot().available, false)
})

test('schema drops private fields, rejects arbitrary events, and limits feedback text', () => {
  assert.equal(sanitizeEvent('$pageview', { $current_url: 'secret' }), null)
  const privateFields = { name: 'private-box', path: '/private/project', token: 'private-token', host: 'private-host', repository: 'https://private/repo', message: 'private-error', command: 'private-command', $current_url: 'private-url', properties: { secret: 'private-nested' } }
  const h = harness(); h.enable()
  h.client.capture('flow_started', { ...privateFields, flow: 'sandbox_creation', location_type: 'ssh', agent_ids: ['codex', 'codex', 'private-agent'], creation_mode: 'quick', file_source: 'repo', setup_count: 2 })
  const payload = h.calls[0].event
  assert.deepEqual(payload.properties.agent_ids, ['codex'])
  assert.equal(payload.properties.$process_person_profile, false)
  assert.equal(payload.properties.$geoip_disable, true)
  assert.equal(payload.properties.environment, 'production')
  assert.doesNotMatch(JSON.stringify(payload), /private-/)
  assert.equal(h.calls[0].init.credentials, 'omit')
  assert.equal(h.calls[0].init.referrerPolicy, 'no-referrer')
  assert.equal(h.calls[0].init.redirect, 'error')
  assert.equal(sanitizeEvent('feedback_submitted', { text: 'x'.repeat(3000) }).text.length, 2000)
  assert.equal(sanitizeEvent('feature_used', { text: 'secret', count: -1 }).text, undefined)
  assert.equal(classifyAnalyticsError({ message: 'host private-host timed out' }), 'unknown')
})

test('failed, rejected, synchronous and timed-out requests are never retried or persisted', async () => {
  for (const send of [() => Promise.reject(Error('offline')), () => { throw Error('DNS') }, () => Promise.resolve({ ok: false, status: 500 }), () => new Promise(() => {})]) {
    const h = harness({ send }); h.enable(); h.client.capture('view_opened', { view: 'sandboxes' })
    await tick(); h.advance(600000); await tick()
    assert.equal(h.calls.length, 1)
    assert.doesNotMatch(JSON.stringify([...h.data]), /view_opened|sandboxes/)
    h.client.capture('feature_used', { feature: 'sandbox', action: 'started' }); await tick()
    assert.equal(h.calls.length, 2) // new events are allowed, old events never replay
    h.client.stop()
  }
})

test('transport concurrency and request lifetime are bounded without a queue', () => {
  const h = harness({ send: () => new Promise(() => {}) }); h.enable()
  for (let i = 0; i < 100; i++) h.client.capture('view_opened')
  assert.equal(h.calls.length, 6)
  h.advance(3001)
  assert.ok(h.calls.every(call => call.init.signal.aborted))
  assert.equal(h.calls.length, 6)
  h.client.capture('view_opened'); assert.equal(h.calls.length, 7)
  h.client.stop()
})

test('revocation from another tab aborts requests and prevents future delivery', () => {
  const h = harness({ send: () => new Promise(() => {}) }); h.enable(); h.client.capture('view_opened')
  h.storage.setItem(USAGE_KEY, 'no')
  h.client.capture('feature_used', { feature: 'files', action: 'uploaded' })
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].init.signal.aborted, true)
  assert.equal(h.client.getSnapshot().sharing, false)
  h.client.setSharing(false)
  assert.deepEqual([...h.data], [[USAGE_KEY, 'no']])
})

test('explicit feedback can be submitted without enabling usage or persisting an identity', () => {
  const h = harness(); h.configure(); h.client.setSharing(false)
  h.client.submitFeedback({ prompt: 'general', text: 'missing capability', category: 'missing_capability' })
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].event.properties.feedback_only, true)
  assert.equal(h.calls[0].event.properties.text, 'missing capability')
  assert.equal(h.calls[0].event.properties.$session_id, undefined)
  assert.deepEqual([...h.data], [[USAGE_KEY, 'no']])
  h.client.capture('view_opened'); assert.equal(h.calls.length, 1)
})

test('screen and initial gateway observations deduplicate and include already connected gateways', async () => {
  const h = harness(); h.enable()
  h.client.observeConsole('connecting'); h.client.observeConsole('live'); h.client.observeConsole('live'); h.client.observeConsole('gateway-down')
  h.client.observeView('sandboxes'); h.client.observeView('sandboxes'); h.client.observeView('activity'); h.client.observeView('sandboxes')
  assert.equal(h.calls.filter(call => call.event.event === 'console_opened').length, 1)
  assert.equal(h.calls[0].event.properties.gateway_state, 'available')
  assert.deepEqual(h.calls.filter(call => call.event.event === 'view_opened').map(call => call.event.properties.view), ['sandboxes', 'activity', 'sandboxes'])
  assert.equal(h.calls[0].event.properties.first_observed_visit, true)
  await tick()
})

test('creation, readiness and browser session success remain distinct observations', async () => {
  const h = harness(); h.enable()
  const creation = h.client.startFlow('sandbox_creation', { creation_mode: 'quick', location_type: 'local' })
  h.client.finishFlow(creation, 'created'); await tick()
  assert.equal(h.calls.some(call => call.event.event === 'sandbox_ready'), false)
  h.advance(10000); h.client.ready(creation); h.client.ready(creation); await tick()
  const ready = h.calls.filter(call => call.event.event === 'sandbox_ready')
  assert.equal(ready.length, 1); assert.equal(ready[0].event.properties.duration_ms, 10000)
  const launch = h.client.startFlow('session_launch', { launch_target: 'terminal' }); await tick()
  h.client.finishFlow(launch, 'handoff_requested'); h.client.finishFlow(launch, 'live'); await tick()
  assert.equal(h.calls.filter(call => call.event.properties.outcome === 'live').length, 0)
})

test('creation retries correlate and step polling deduplicates without automatic questions', async () => {
  const h = harness(); h.enable()
  let item = h.client.startFlow('sandbox_creation', { file_source: 'repo' }); await tick()
  for (let i = 0; i < 50; i++) h.client.step(item, 'building_image')
  h.client.finishFlow(item, 'failed', 'image_build'); await tick()
  assert.equal(Object.hasOwn(h.client.getSnapshot(), 'candidate'), false)
  item = h.client.startFlow('sandbox_creation', { file_source: 'repo' }, item); await tick()
  h.client.finishFlow(item, 'failed', 'image_build'); h.client.finishFlow(item, 'failed', 'unknown'); await tick()
  const starts = h.calls.filter(call => call.event.event === 'flow_started')
  assert.deepEqual(starts.map(call => call.event.properties.attempt), [1, 2])
  assert.equal(starts[0].event.properties.flow_id, starts[1].event.properties.flow_id)
  assert.equal(h.calls.filter(call => call.event.event === 'flow_finished').length, 2)
  assert.equal(h.calls.filter(call => call.event.properties.step === 'building_image').length, 1)
  assert.equal(Object.hasOwn(h.client.getSnapshot(), 'candidate'), false)
  assert.equal(h.data.has('openrod.feedback-candidate.v1'), false)
  assert.equal(h.data.has('openrod.feedback-last.v1'), false)
  assert.equal(h.calls.some(call => call.event.event === 'feedback_prompted'), false)
})

test('pre-submission cancellation is distinguishable from a submitted attempt', async () => {
  const h = harness(); h.enable()
  const exploration = h.client.exploreFlow('sandbox_creation'); h.client.step(exploration, 'configuration')
  h.client.step(exploration, 'validation', 'blocked', 'unknown'); h.client.finishFlow(exploration, 'cancelled'); await tick()
  const end = h.calls.find(call => call.event.event === 'flow_finished').event
  assert.equal(end.properties.start_observed, false)
  assert.equal(end.properties.duration_ms, undefined)
  assert.equal(h.calls.some(call => call.event.event === 'flow_started'), false)
})

test('legacy goals and feedback prompts are ignored and cleared on opt-out', async () => {
  const h = harness()
  const legacy = ['openrod.intent.v1', 'openrod.feedback-candidate.v1', 'openrod.feedback-last.v1']
  h.data.set(legacy[0], 'tools')
  h.data.set(legacy[1], JSON.stringify({ prompt: 'outcome', flow_id: '00000001-0000-4000-8000-000000000000', at: 1800000000000 }))
  h.data.set(legacy[2], '1800000000000')
  h.enable(); h.client.observeConsole('live'); await tick()
  assert.equal(Object.hasOwn(h.client.getSnapshot(), 'intent'), false)
  assert.equal(Object.hasOwn(h.client.getSnapshot(), 'candidate'), false)
  assert.equal(h.calls[0].event.properties.intent, undefined)
  assert.equal(h.client.setIntent, undefined)
  assert.equal(h.client.promptEligible, undefined)
  assert.equal(h.client.promptInteraction, undefined)
  h.client.setSharing(false)
  assert.ok(legacy.every(key => !h.data.has(key)))
  assert.deepEqual([...h.data], [[USAGE_KEY, 'no']])
})

test('successful sessions and native handoffs never create automatic question state', async () => {
  const h = harness(); h.enable()
  for (const outcome of ['live', 'handoff_requested']) {
    const item = h.client.startFlow('session_launch'); await tick()
    h.client.finishFlow(item, outcome); await tick()
  }
  assert.equal(Object.hasOwn(h.client.getSnapshot(), 'intent'), false)
  assert.equal(Object.hasOwn(h.client.getSnapshot(), 'candidate'), false)
  assert.equal(h.data.has('openrod.intent.v1'), false)
  assert.equal(h.data.has('openrod.feedback-candidate.v1'), false)
  assert.equal(h.data.has('openrod.feedback-last.v1'), false)
  assert.equal(h.calls.some(call => call.event.event === 'feedback_prompted'), false)
})

test('terminal correlation stores only safe metadata and restores the opener flow', async () => {
  let href = 'http://localhost/?target=local#terminal/private-name?gateway=private-host&workspace=private-workspace'
  const h = harness({ getLocation: () => href }); h.enable()
  const anchor = { href }
  h.client.terminalClick({ currentTarget: anchor }, { location_type: 'ssh', name: 'private-name' }); await tick()
  href = anchor.href
  const started = h.calls.find(call => call.event.event === 'flow_started').event
  const restored = h.client.terminalFlow({ location_type: 'ssh' })
  assert.equal(restored.id, started.properties.flow_id)
  assert.doesNotMatch(JSON.stringify([...h.data]), /private-/)
  h.client.finishFlow(restored, 'live'); await tick()
  assert.equal(h.calls.filter(call => call.event.event === 'flow_started').length, 1)
})

test('only a tracked template build completing at its own location counts as feature use', async () => {
  const h = harness(); h.enable()
  h.client.templateStarted({ name: 'private-template', status: 'building', startedAt: 'current' }, { context: 'private-context', remote: true })
  h.client.observeTemplates([{ name: 'private-template', status: 'ready', startedAt: 'old', location: { context: 'private-context' } }])
  h.client.observeTemplates([{ name: 'private-template', status: 'ready', startedAt: 'current', location: { context: 'other' } }])
  assert.equal(h.calls.length, 0)
  const current = [{ name: 'private-template', status: 'ready', startedAt: 'current', location: { context: 'private-context' } }]
  h.client.observeTemplates(current); h.client.observeTemplates(current); await tick()
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].event.properties.location_type, 'ssh')
  assert.doesNotMatch(JSON.stringify(h.calls[0].event), /private-/)
})

test('background creation telemetry survives dialog closure, reports retry and readiness once', async () => {
  const h = harness(); h.enable()
  const jobs = createSandboxCreations({ telemetry: h.client })
  let attempts = 0
  const id = jobs.start({ name: 'private-name', location: { context: 'private-context' }, analyticsProperties: { file_source: 'repo' }, task: async report => {
    report.build({ logs: 'private-log', status: 'building' }); report.creating()
    if (++attempts === 1) throw Object.assign(Error('private-error'), { code: 'IMAGE_BUILD_FAILED' })
    return { name: 'private-name' }
  } })
  await tick(); jobs.retry(id); await tick()
  assert.equal(jobs.getSnapshot()[0].status, 'created')
  jobs.update(id, { phase: 'ready' }); jobs.update(id, { phase: 'ready' }); await tick()
  assert.equal(h.calls.filter(call => call.event.event === 'sandbox_ready').length, 1)
  assert.deepEqual(h.calls.filter(call => call.event.event === 'flow_finished').map(call => call.event.properties.outcome), ['failed', 'created'])
  assert.doesNotMatch(JSON.stringify(h.calls.map(call => call.event)), /private-/)
})


test('revocation prevents old workflows being attributed to a newly opted-in identity', async () => {
  const h = harness(); h.enable()
  const old = h.client.startFlow('sandbox_creation'); await tick()
  h.client.setSharing(false); h.client.setSharing(true)
  h.client.step(old, 'creating'); h.client.finishFlow(old, 'failed'); h.client.ready(old)
  assert.equal(h.calls.length, 2)
  assert.equal(Object.hasOwn(h.client.getSnapshot(), 'candidate'), false)
  const next = h.client.startFlow('sandbox_creation', {}, old)
  assert.notEqual(next.id, old.id)
  assert.equal(next.attempt, 1)
})


test('a suspended tab cannot attach an old flow after a rapid off/on toggle elsewhere', async () => {
  const first = harness(); first.enable(); first.client.observeConsole('live'); await tick()
  const suspended = harness({ getStorage: () => first.storage }); suspended.enable()
  const old = suspended.client.startFlow('session_launch'); await tick()
  first.client.setSharing(false); first.client.setSharing(true); first.client.observeConsole('live'); await tick()
  suspended.client.finishFlow(old, 'live'); suspended.client.step(old, 'connecting'); suspended.client.ready(old)
  assert.equal(suspended.calls.length, 2)
  assert.equal(Object.hasOwn(suspended.client.getSnapshot(), 'candidate'), false)
  const next = suspended.client.startFlow('session_launch', {}, old)
  assert.notEqual(next.id, old.id)
  assert.equal(next.attempt, 1)
})
