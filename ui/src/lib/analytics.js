// Explicit, anonymous PostHog capture. No SDK, autocapture, queue, retry, or logs.
// This module is also imported by Node-side libraries: never touch the browser
// until the authorized local UI configures it.
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
export const USAGE_KEY = 'openrod.usage.v1'
const ID_KEY = 'openrod.usage-id.v1'
const LEGACY_INTENT_KEY = 'openrod.intent.v1'
const SESSION_KEY = 'openrod.usage-session.v1'
const LEGACY_PROMPT_KEY = 'openrod.feedback-last.v1'
const TERMINAL_KEY = 'openrod.terminal-flows.v1'
const LEGACY_CANDIDATE_KEY = 'openrod.feedback-candidate.v1'
const choices = (...values) => value => values.includes(value) ? value : undefined
const uuid = value => typeof value === 'string' && UUID.test(value) ? value : undefined
const number = value => Number.isFinite(value) && value >= 0 ? Math.min(Math.round(value), 86400000) : undefined
const boolean = value => typeof value === 'boolean' ? value : undefined
const view = choices('sandboxes', 'activity', 'groups', 'egress', 'ingress', 'secrets', 'templates', 'setups', 'connections', 'terminal')
// Retain historical schema values without collecting or reading goal preferences.
const intent = choices('project', 'access', 'tools', 'remote', 'exploring', 'other')
const flow = choices('gateway_connection', 'sandbox_creation', 'session_launch')
const location = choices('local', 'ssh', 'unknown')
const errorCategory = choices('docker_missing', 'docker_unavailable', 'openshell_missing', 'gateway_unavailable', 'ssh_auth', 'host_key', 'runtime_missing', 'image_build', 'credentials_missing', 'setup_import', 'policy', 'file_seed', 'timeout', 'connection_lost', 'unknown')
const flowFields = { flow, flow_id: uuid, attempt: number, location_type: location, launch_target: choices('browser', 'terminal', 'vscode', 'cursor') }
const prompt = choices('intent', 'outcome', 'blocker', 'general')
const text = value => typeof value === 'string' ? value.trim().slice(0, 2000) : undefined
const agentIds = value => Array.isArray(value) ? [...new Set(value.filter(id => ['claude', 'codex', 'cursor', 'pi', 'antigravity', 'opencode', 'aider', 'copilot', 'kiro', 'droid'].includes(id)))].slice(0, 12) : undefined
const configFields = { creation_mode: choices('quick', 'template'), file_source: choices('empty', 'folder', 'repo'), agent_ids: agentIds, setup_count: number, provider_count: number, group_count: number }
const EVENTS = {
  console_opened: { gateway_state: choices('available', 'setup_required', 'unavailable'), first_observed_visit: boolean, connection_method: choices('automatic', 'manual', 'existing', 'unknown') },
  view_opened: { previous_view: view },
  intent_selected: { intent },
  flow_started: { ...flowFields, ...configFields },
  flow_step_changed: { ...flowFields, step: choices('location', 'configuration', 'validation', 'host_selection', 'connecting', 'needs_docker', 'needs_runtime', 'preparing_tools', 'building_image', 'creating', 'requesting'), state: choices('entered', 'blocked'), error_category: errorCategory },
  flow_finished: { ...flowFields, ...configFields, outcome: choices('connected', 'created', 'live', 'handoff_requested', 'failed', 'cancelled'), duration_ms: number, start_observed: boolean, error_category: errorCategory },
  sandbox_ready: { flow_id: uuid, duration_ms: number, location_type: location },
  feature_used: { feature: choices('template', 'setup', 'network', 'group', 'activity', 'files', 'sandbox'), action: choices('built', 'imported', 'activated', 'rule_saved', 'membership_saved', 'filter_applied', 'exported', 'uploaded', 'started', 'stopped', 'deleted'), count: number, location_type: location },
  feedback_prompted: { prompt, interaction: choices('shown', 'dismissed'), flow_id: uuid },
  feedback_submitted: { prompt, category: choices('setup', 'connection', 'missing_capability', 'instructions', 'other', 'general'), goal_achieved: choices('yes', 'partly', 'no'), text, flow_id: uuid, feedback_only: boolean },
}

export function sanitizeEvent(event, properties = {}) {
  if (!Object.hasOwn(EVENTS, event)) return null
  const safe = {}
  for (const [key, validate] of Object.entries({ view, intent, ...EVENTS[event] })) {
    const value = validate(properties[key])
    if (value !== undefined) safe[key] = value
  }
  return safe
}

// Match structured codes only. Error messages can contain private host/path data.
export function classifyAnalyticsError(error) {
  const codes = {
    DOCKER_NOT_INSTALLED: 'docker_missing', DOCKER_UNAVAILABLE: 'docker_unavailable', GATEWAY_DOCKER_MISMATCH: 'docker_unavailable',
    OPENSHELL_NOT_INSTALLED: 'openshell_missing', SSH_AUTH_FAILED: 'ssh_auth', HOST_KEY_REJECTED: 'host_key',
    RUNTIME_MISSING: 'runtime_missing', IMAGE_BUILD_FAILED: 'image_build', CREDENTIALS_MISSING: 'credentials_missing',
    SETUP_IMPORT_FAILED: 'setup_import', GATEWAY_UNAVAILABLE: 'gateway_unavailable',
  }
  if (error?.name === 'TimeoutError') return 'timeout'
  return codes[error?.code] ?? 'unknown'
}

export function createAnalytics({ getStorage = () => window.localStorage, getLocation = () => window.location.href,
  randomUUID = () => crypto.randomUUID(), now = () => Date.now(), fetch: send = (...args) => fetch(...args),
  setTimer = setTimeout, clearTimer = clearTimeout,
  config = typeof __OPENROD_ANALYTICS__ === 'undefined' ? {} : __OPENROD_ANALYTICS__,
} = {}) {
  let authorized = false, runtimeEnabled = false, storageFailed = false, currentView, lastView, opened = false, firstVisit
  const destination = config.host === 'https://eu.i.posthog.com' ? 'EU' : 'US'
  let state = Object.freeze({ available: false, sharing: null, destination })
  const listeners = new Set(), pending = new Map(), finished = new Set(), steps = new Map(), templates = new Map()
  let recent = [], generation = 0
  const storage = () => getStorage()
  const safe = (operation, fallback) => { try { return operation() } catch { return fallback } }
  function halt() {
    generation++
    for (const [controller, timer] of pending) { controller.abort(); clearTimer(timer) }
    pending.clear(); finished.clear(); steps.clear(); templates.clear(); recent = []
    opened = false; lastView = undefined; firstVisit = undefined
  }
  function cleanLocation() {
    const url = new URL(getLocation())
    return !url.searchParams.has('token') && !url.searchParams.has('handoff') && !/^#local-(connect|return)=/.test(url.hash)
      && !(config.environment === 'development' && url.searchParams.has('fleet'))
  }
  function available() {
    return safe(() => authorized && runtimeEnabled && !storageFailed && config.enabled === true && /^phc_[a-zA-Z0-9]+$/.test(config.projectToken ?? '')
      && ['https://us.i.posthog.com', 'https://eu.i.posthog.com'].includes(config.host) && cleanLocation(), false)
  }
  function refresh() {
    safe(() => {
      let sharing = null
      try {
        const value = storage().getItem(USAGE_KEY); sharing = value === 'yes' ? true : value === 'no' ? false : null
      }
      catch { storageFailed = true; halt() }
      if (sharing !== true && state.sharing === true) halt()
      const next = { available: available(), sharing, destination }
      if (Object.keys(next).some(key => next[key] !== state[key])) {
        state = Object.freeze(next)
        for (const notify of listeners) safe(notify)
      }
    })
  }
  function configure({ enabled = false, mode = 'local' } = {}) {
    safe(() => { authorized = mode === 'local'; runtimeEnabled = enabled; if (!authorized || !enabled) halt(); refresh() })
  }
  function setSharing(value) {
    safe(() => {
      try {
        storage().setItem(USAGE_KEY, value ? 'yes' : 'no')
        if (!value) {
          for (const key of [ID_KEY, SESSION_KEY, TERMINAL_KEY, LEGACY_INTENT_KEY, LEGACY_PROMPT_KEY, LEGACY_CANDIDATE_KEY]) storage().removeItem(key)
          halt()
        }
      } catch { storageFailed = true; halt() }
      refresh()
    })
  }
  function identity() {
    const store = storage()
    let id = uuid(store.getItem(ID_KEY)), session
    const first = !id
    firstVisit ??= first
    if (!id) { id = randomUUID(); store.setItem(ID_KEY, id) }
    try { session = JSON.parse(store.getItem(SESSION_KEY)) } catch { /* invalid old state */ }
    if (!uuid(session?.id) || !Number.isFinite(session?.at) || now() - session.at > 1800000) session = { id: randomUUID() }
    store.setItem(SESSION_KEY, JSON.stringify({ id: session.id, at: now() }))
    return { id, session: session.id, first: firstVisit }
  }
  function capture(event, properties = {}, { explicitFeedback = false } = {}) {
    return safe(() => {
      refresh()
      if (!state.available || (state.sharing !== true && !(explicitFeedback && event === 'feedback_submitted'))) return false
      const sanitized = sanitizeEvent(event, properties)
      if (!sanitized) return false
      // Recheck the stored preference before every request, including in other tabs.
      const regular = state.sharing === true
      let who
      try { who = regular ? identity() : { id: randomUUID() } } catch { storageFailed = true; halt(); refresh(); return false }
      recent = recent.filter(at => now() - at < 60000)
      if (pending.size >= 6 || recent.length >= 120) return false
      const controller = new AbortController()
      const timer = setTimer(() => { controller.abort(); pending.delete(controller) }, 3000)
      pending.set(controller, timer); recent.push(now())
      const payload = {
        api_key: config.projectToken, event, distinct_id: who.id, timestamp: new Date(now()).toISOString(),
        properties: { schema_version: 1, app_version: config.version, environment: config.environment,
          ...(who.session ? { $session_id: who.session } : {}),
          ...(currentView ? { view: currentView } : {}),
          ...sanitized, $process_person_profile: false, $geoip_disable: true,
          ...(event === 'console_opened' ? { first_observed_visit: who.first } : {}),
          ...(explicitFeedback ? { feedback_only: !regular } : {}),
        },
      }
      const done = () => { clearTimer(timer); pending.delete(controller) }
      if (event === 'console_opened') firstVisit = false
      try {
        Promise.resolve(send(`${config.host}/i/v0/e/`, { method: 'POST', headers: { 'content-type': 'text/plain' },
          body: JSON.stringify(payload), signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer',
          cache: 'no-store', redirect: 'error', keepalive: false,
        })).then(done, done)
      } catch { done() }
      return true // Attempted, never a delivery acknowledgement.
    }, false)
  }
  function observeConsole(connection) {
    safe(() => {
      if (opened || !['live', 'setup-required', 'gateway-down'].includes(connection)) return
      if (capture('console_opened', { gateway_state: connection === 'live' ? 'available' : connection === 'setup-required' ? 'setup_required' : 'unavailable', connection_method: 'existing' })) opened = true
    })
  }
  function observeView(next) {
    safe(() => { currentView = view(next); if (currentView && currentView !== lastView && capture('view_opened', { previous_view: lastView })) lastView = currentView })
  }
  function startFlow(kind, properties = {}, previous = null) {
    return safe(() => {
      refresh()
      if (!state.available || state.sharing !== true || !flow(kind)) return null
      const installationId = identity().id
      if (previous?.generation !== generation || previous?.installationId !== installationId) previous = null
      const item = { generation, installationId, id: previous?.id ?? randomUUID(), flow: kind, attempt: (previous?.attempt ?? 0) + 1, started: now(), properties: sanitizeEvent('flow_started', properties) }
      capture('flow_started', { ...item.properties, flow: kind, flow_id: item.id, attempt: item.attempt })
      step(item, kind === 'session_launch' ? 'requesting' : kind === 'gateway_connection' ? 'connecting' : 'preparing_tools')
      return item
    }, null)
  }
  function exploreFlow(kind, properties = {}) {
    return safe(() => {
      refresh(); if (!state.available || state.sharing !== true || !flow(kind)) return null
      return { generation, installationId: identity().id, id: randomUUID(), flow: kind, attempt: 0, started: null, properties: sanitizeEvent('flow_started', properties) }
    }, null)
  }
  // Also bind to the stored identity: a suspended tab can miss the brief
  // opt-out state if sharing is turned off and back on before it resumes.
  const activeFlow = item => item && item.generation === generation && state.available && state.sharing === true
    && uuid(item.installationId) && item.installationId === storage().getItem(ID_KEY)
  const fields = item => ({ ...item.properties, flow: item.flow, flow_id: item.id, attempt: item.attempt })
  function step(item, next, phaseState = 'entered', category) {
    safe(() => {
      refresh(); if (!activeFlow(item)) return
      const key = `${item.id}:${item.attempt}`, value = `${next}:${phaseState}:${category}`
      if (steps.get(key) === value) return
      if (steps.size >= 100) steps.delete(steps.keys().next().value)
      steps.set(key, value)
      capture('flow_step_changed', { ...fields(item), step: next, state: phaseState, error_category: category })
    })
  }
  function finishFlow(item, outcome, category) {
    safe(() => {
      refresh(); if (!activeFlow(item)) return
      const key = `${item.id}:${item.attempt}`
      if (finished.has(key)) return
      if (finished.size >= 200) finished.delete(finished.values().next().value)
      finished.add(key); steps.delete(key)
      item.outcome = outcome
      capture('flow_finished', { ...fields(item), outcome, start_observed: item.started !== null, duration_ms: item.started === null ? undefined : now() - item.started, error_category: category })
    })
  }
  function ready(item) {
    safe(() => {
      refresh(); if (!activeFlow(item)) return
      const key = `${item.id}:ready`
      if (finished.has(key)) return
      if (finished.size >= 200) finished.delete(finished.values().next().value)
      finished.add(key)
      capture('sandbox_ready', { flow_id: item.id, duration_ms: now() - item.started, location_type: item.properties.location_type })
    })
  }
  function submitFeedback(properties) {
    capture('feedback_submitted', properties, { explicitFeedback: true })
  }
  // Only safe correlation metadata is stored, never a name, command, or host.
  function terminalClick(event, properties = {}) {
    safe(() => {
      const item = startFlow('session_launch', { ...properties, launch_target: 'browser' })
      refresh(); if (!activeFlow(item)) return
      const url = new URL(event.currentTarget.href)
      const [path, query = ''] = url.hash.split('?')
      const params = new URLSearchParams(query); params.set('analyticsFlow', item.id)
      url.hash = `${path}?${params}`
      try {
        const saved = readTerminalFlows()
        saved.push(item); storage().setItem(TERMINAL_KEY, JSON.stringify(saved.slice(-20)))
        event.currentTarget.href = url.href
      } catch { /* Losing correlation cannot affect the link. */ }
    })
  }
  function readTerminalFlows() {
    let values = []
    try { values = JSON.parse(storage().getItem(TERMINAL_KEY) || '[]') } catch { /* stale state */ }
    return Array.isArray(values) ? values.filter(item => uuid(item.id) && item.flow === 'session_launch' && Number.isFinite(item.started) && now() - item.started < 1800000).slice(-20) : []
  }
  function terminalFlow(properties, previous) {
    return safe(() => {
      refresh(); if (!state.available || state.sharing !== true) return null
      if (previous) return startFlow('session_launch', properties, previous)
      const id = new URLSearchParams(new URL(getLocation()).hash.split('?')[1]).get('analyticsFlow')
      const installationId = identity().id
      const restored = readTerminalFlows().find(item => item.id === id && item.installationId === installationId)
      if (!restored) return startFlow('session_launch', { ...properties, launch_target: 'browser' })
      return { generation, installationId, id: restored.id, flow: 'session_launch', attempt: number(restored.attempt) ?? 1, started: restored.started, properties: sanitizeEvent('flow_started', restored.properties) }
    }, null)
  }
  function templateStarted(record, owner) {
    safe(() => {
      refresh(); if (!state.available || state.sharing !== true) return
      if (record.status === 'ready') { capture('feature_used', { feature: 'template', action: 'built', location_type: analyticsLocation(owner) }); return }
      if (record.status !== 'building') return
      if (templates.size >= 100) templates.delete(templates.keys().next().value)
      templates.set(JSON.stringify([owner?.context, record.name]), { installationId: identity().id, startedAt: record.startedAt, at: now(), location_type: analyticsLocation(owner) })
    })
  }
  function observeTemplates(records) {
    safe(() => {
      for (const record of records) {
        const key = JSON.stringify([record.location?.context, record.name]), tracked = templates.get(key)
        if (!tracked) continue
        if (tracked.installationId !== storage().getItem(ID_KEY) || now() - tracked.at > 1800000) { templates.delete(key); continue }
        if (record.startedAt !== tracked.startedAt || record.location?.connected === false) continue
        if (record.status === 'ready') { templates.delete(key); capture('feature_used', { feature: 'template', action: 'built', location_type: tracked.location_type }) }
        else if (record.status === 'failed') templates.delete(key)
      }
    })
  }
  return { configure, setSharing, refresh, capture, observeConsole, observeView, startFlow, exploreFlow, step, finishFlow, ready, templateStarted, observeTemplates,
    submitFeedback, terminalClick, terminalFlow,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) }, getSnapshot: () => state,
    stop: () => { authorized = false; halt(); refresh() },
  }
}

export const analytics = createAnalytics()
export const analyticsLocation = value => value?.remote ? 'ssh' : 'local'

// Capture successful product mutations at the shared API boundary. Only fixed
// method/path patterns select events; no path, response, or request body is sent.
export function analyticsFeatureRequest(suffix, method) {
  if (method === 'GET' || method === undefined) return
  const rules = [
    [/^\/setups\/save$/, 'setup', 'imported'], [/^\/setups\/[^/]+\/enable$/, 'setup', 'activated'],
    [/^\/egress\/policies$/, 'network', 'rule_saved'], [/^\/org\/members$/, 'group', 'membership_saved'],
    [/^\/files\/[^/]+\/uploads\/[^/]+\/commit$/, 'files', 'uploaded'],
    [/^\/sandboxes\/[^/]+\/start$/, 'sandbox', 'started'], [/^\/sandboxes\/[^/]+\/stop$/, 'sandbox', 'stopped'], [/^\/sandboxes\/[^/]+\/delete$/, 'sandbox', 'deleted'],
  ]
  const rule = rules.find(([pattern]) => pattern.test(suffix))
  if (rule) analytics.capture('feature_used', { feature: rule[1], action: rule[2] })
}
