// Browser side of the console API. Every call is same-origin; the server
// holds the gateway certificate, so nothing here carries a credential.

import { computeApiPath, currentComputeTarget, currentCloudOwner } from './compute-target.js'
import { analyticsFeatureRequest } from './analytics.js'

// The local server answers 401 with this code until the browser opens the
// tokened link that `openrod` prints; the app then shows how to get back in.
export const LINK_REQUIRED = 'CONSOLE_TOKEN_REQUIRED'

export function createApi(target, signal, locationContext = null, boundOwner = currentCloudOwner()) {
  const selected = () => target ?? currentComputeTarget()
  const owner = boundOwner
  let binding, loadingBinding
  const path = suffix => computeApiPath(selected(), suffix)
  const requestSignal = extra => signal && extra ? AbortSignal.any([signal, extra]) : signal ?? extra
  async function loadContext() {
    signal?.throwIfAborted()
    const response = await fetch(path('/context'), { signal, headers: selected() === 'cloud' && owner ? { 'x-openrod-local-owner': owner } : undefined })
    const context = await response.json()
    signal?.throwIfAborted()
    if (context.code === LINK_REQUIRED) window.dispatchEvent(new Event(LINK_REQUIRED))
    else if (response.status === 401 || context.code === 'CLOUD_OWNER_CHANGED') window.dispatchEvent(new Event('openrod-session-expired'))
    if (!response.ok) throw new Error(context.error ?? 'Could not read gateway registrations.')
    binding ??= JSON.stringify([context.gateway, context.workspace])
    return context
  }
  async function contextKey() {
    signal?.throwIfAborted()
    if (locationContext != null) return locationContext
    if (!binding) {
      loadingBinding ??= loadContext().finally(() => { loadingBinding = null })
      await loadingBinding
    }
    return binding
  }
  async function request(suffix, { method = 'GET', body, signal: extraSignal, scoped = true, raw = false } = {}) {
    const currentSignal = requestSignal(extraSignal)
    currentSignal?.throwIfAborted()
    const context = scoped ? await contextKey() : null
    currentSignal?.throwIfAborted()
    const response = await fetch(path(suffix), {
      method, signal: currentSignal,
      headers: {
        ...(selected() === 'cloud' && owner ? { 'x-openrod-local-owner': owner } : {}),
        ...(context ? { 'x-openshell-context': context } : {}),
        ...(context && locationContext ? { 'x-openshell-location': '1' } : {}),
        ...(method === 'GET' ? {} : { 'content-type': raw ? 'application/octet-stream' : 'application/json', 'x-openshell-console': '1' }),
      },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    })
    const payload = await response.json().catch(() => ({}))
    currentSignal?.throwIfAborted()
    if (payload.code === LINK_REQUIRED) window.dispatchEvent(new Event(LINK_REQUIRED))
    else if (response.status === 401 || payload.code === 'CLOUD_OWNER_CHANGED') window.dispatchEvent(new Event('openrod-session-expired'))
    if (!response.ok) throw Object.assign(new Error(payload.error ?? `Request failed (${response.status})`), { code: payload.code, sandboxes: payload.sandboxes, fix: payload.fix })
    analyticsFeatureRequest(suffix, method)
    return payload
  }
  return {
    target, signal, path, owner,
    url: (suffix, params = {}) => {
      const query = new URLSearchParams({ ...params, ...(selected() === 'cloud' && owner ? { owner } : {}) })
      return path(suffix) + (query.size ? '?' + query : '')
    },
    forContext: context => createApi(target, signal, context, owner),
    inventory: extraSignal => request('/inventory', { signal: extraSignal, scoped: false }),
    context: loadContext,
    contextKey,
    connections: extraSignal => request('/connections', { signal: extraSignal, scoped: false }),
    connectionJob: (id, extraSignal) => request(`/connections/jobs/${encodeURIComponent(id)}`, { signal: extraSignal, scoped: false }),
    connect: body => request('/connections/connect', { method: 'POST', body }),
    installConnectionDocker: id => request(`/connections/jobs/${encodeURIComponent(id)}/docker`, { method: 'POST', body: { approve: true } }),
    installConnectionRuntime: id => request(`/connections/jobs/${encodeURIComponent(id)}/install`, { method: 'POST', body: { method: 'download' } }),
    uploadConnectionPackage: (id, file) => request(`/connections/jobs/${encodeURIComponent(id)}/package`, { method: 'POST', body: file, raw: true }),
    scanSshHost: body => request('/connections/hosts/scan', { method: 'POST', body }),
    addSshHost: token => request('/connections/hosts', { method: 'POST', body: { token } }),
    removeSshHost: alias => request('/connections/hosts/remove', { method: 'POST', body: { alias } }),
    forgetRemote: () => request('/connections/forget', { method: 'POST', body: {} }),
    disconnectRemote: () => request('/connections/disconnect', { method: 'POST', body: {} }),
    syncLocalCatalog: () => request('/local-catalog', { method: 'POST', body: {} }),
    gatewayDocker: (fresh = false) => request(`/gateway-docker${fresh ? '?fresh=1' : ''}`, { scoped: false }),
    connectGatewayDocker: (seen = [], confirm = true) => request('/gateway-docker/connect', { method: 'POST', body: { confirm, seen }, scoped: false }),
    undoGatewayDocker: (seen = []) => request('/gateway-docker/undo', { method: 'POST', body: { confirm: true, seen }, scoped: false }),
  setups: () => request('/setups'),
  discoverSetups: (sources) => request('/setups/scan', { method: 'POST', body: { sources } }),
  reviewSetup: (token, ids) => request('/setups/review', { method: 'POST', body: { token, ids } }),
  removeSetupReviewItem: (token, item) => request('/setups/remove-review-item', { method: 'POST', body: { token, item } }),
  prepareSetup: (token, items) => request('/setups/prepare', { method: 'POST', body: { token, items, approved: true } }),
  prepareLaunchSetup: (id, revision) => request(`/setups/${id}/prepare-launch`, { method: 'POST', body: { revision } }),
  prepareSavedSetup: (id) => request(`/setups/${id}/prepare`, { method: 'POST', body: {} }),
  setupPreparation: (id) => request(`/setups/preparations/${id}`),
  cancelSetupPreparation: (id) => request(`/setups/preparations/${id}/cancel`, { method: 'POST', body: {} }),
  setupFile: (token, item, path) => request('/setups/file', { method: 'POST', body: { token, item, path } }),
  saveSetup: (token, name, acknowledged) => request('/setups/save', { method: 'POST', body: { token, name, acknowledged } }),
  deleteSetup: (id, revision) => request(`/setups/${id}/delete`, { method: 'POST', body: { revision } }),
  deleteSetupItem: (id, item, revision) => request(`/setups/${id}/delete-item`, { method: 'POST', body: { item, revision } }),
  previewSetup: (id, sandbox, targets) => request(`/setups/${id}/preview`, { method: 'POST', body: { sandbox, targets } }),
  enableSetup: (id, sandbox, token, approveAccess = false) => request(`/setups/${id}/enable`, { method: 'POST', body: { sandbox, token, approveAccess } }),
  removeSetup: (id, sandbox, token) => request(`/setups/${id}/remove`, { method: 'POST', body: { sandbox, token } }),
  setupJobs: (id) => request(`/setups/${id}/jobs`),
  cloudExport: (name) => request(`/cloud-export?name=${encodeURIComponent(name)}`),
  importCloud: (bundle) => request("/cloud-import", { method: "POST", body: bundle }),
  cloudTransfer: (name, ticket) => request("/cloud-transfer", { method: "POST", body: { name, ticket } }),
  selectContext: (body) => request("/context", { method: "POST", body }),
  previewActivityDeletion: (body) => request('/activity/delete-preview', { method: 'POST', body }),
  deleteActivity: (token) => request('/activity/delete', { method: 'POST', body: { token } }),
  activityDestinations: () => request('/activity-destinations'),
  createActivityDestination: (body) => request('/activity-destinations', { method: 'POST', body }),
  activityDestinationAction: (id, action) => request(`/activity-destinations/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: {} }),
  overview: () => request("/overview"),
  sandbox: (name) => request(`/sandboxes/${encodeURIComponent(name)}`),
  activity: (options = {}) => request(`/activity?query=${encodeURIComponent(JSON.stringify(options))}`),
  create: (spec) => request("/sandboxes", { method: "POST", body: spec }),
  sshConnection: (name) => request(`/sandboxes/${encodeURIComponent(name)}/ssh`),
  openSshTerminal: (name, mode) => request(`/sandboxes/${encodeURIComponent(name)}/ssh-open`, { method: "POST", body: { mode } }),
  sshConfig: (name) => request(`/sandboxes/${encodeURIComponent(name)}/ssh-config`, { method: "POST", body: {} }),
  terminalSession: (name, body) => request(`/sandboxes/${encodeURIComponent(name)}/terminal-session`, { method: "POST", body }),
  lifecycle: (name, action) => request(`/sandboxes/${encodeURIComponent(name)}/${action}`, { method: "POST", body: {} }),
  editors: () => request("/editors"),
  openEditor: (name, editor) => request(`/sandboxes/${encodeURIComponent(name)}/editor`, { method: "POST", body: { editor } }),

  // Policy center
  fleetPolicy: () => request("/policy/fleet"),
  policy: (sandbox) => request(`/policy/${encodeURIComponent(sandbox)}`),
  revision: (sandbox, version) => request(`/policy/${encodeURIComponent(sandbox)}/revisions/${version}`),
  applyOps: (sandbox, ops) => request(`/policy/${encodeURIComponent(sandbox)}/ops`, { method: "POST", body: { ops } }),
  restore: (sandbox, version) => request(`/policy/${encodeURIComponent(sandbox)}/restore`, { method: "POST", body: { version } }),
  globalPolicy: () => request("/policy/global"),
  removeGlobal: () => request("/policy/global/remove", { method: "POST", body: {} }),
  settings: (sandbox) => request(`/settings${sandbox ? `/${encodeURIComponent(sandbox)}` : ""}`),
  setSetting: (body) => request("/settings", { method: "POST", body }),
  secrets: () => request("/secrets"),
  createSecret: (body) => request("/secrets", { method: "POST", body }),
  rotateSecret: (name, credentials) => request(`/secrets/${encodeURIComponent(name)}/rotate`, { method: "POST", body: { credentials } }),
  secretExpiry: (name, key, expiresAt) => request(`/secrets/${encodeURIComponent(name)}/expiry`, { method: "POST", body: { key, expiresAt } }),
  deleteSecret: (name) => request(`/secrets/${encodeURIComponent(name)}/delete`, { method: "POST", body: {} }),
  attachSecret: (name, sandbox, attach) => request(`/secrets/${encodeURIComponent(name)}/${attach ? "attach" : "detach"}`, { method: "POST", body: { sandbox } }),
  importProfile: (id) => request("/profiles/import", { method: "POST", body: { id } }),
  deleteTemplates: (ids) => request("/templates/delete", { method: "POST", body: { ids } }),
  templates: () => request("/templates"),
  imageTemplates: () => request("/image-templates"),
  localImages: () => request("/image-templates/local-images"),
  buildImageTemplate: (recipe, replace = false) => request("/image-templates", { method: "POST", body: { recipe, replace } }),
  cancelImageBuild: (name) => request(`/image-templates/${encodeURIComponent(name)}/cancel`, { method: "POST", body: {} }),
  dismissImageBuild: (name) => request(`/image-templates/${encodeURIComponent(name)}/dismiss`, { method: "POST", body: {} }),
  imageTemplateUsage: (name) => request(`/image-templates/${encodeURIComponent(name)}/usage`),
  deleteImageTemplate: (name) => request(`/image-templates/${encodeURIComponent(name)}/delete`, { method: "POST", body: {} }),
  org: () => request("/org"),
  saveOrg: (org) => request("/org", { method: "POST", body: org }),
  saveGroup: (group) => request("/org/groups", { method: "POST", body: group }),
  deleteGroup: (id) => request(`/org/groups/${encodeURIComponent(id)}/delete`, { method: "POST", body: {} }),
  setGroupMembers: (sandboxes, groups, mode = "replace") => request("/org/members", { method: "POST", body: { sandboxes, groups, mode } }),
  savePolicy: (policy) => request("/egress/policies", { method: "POST", body: policy }),
  deletePolicy: (id) => request(`/egress/policies/${encodeURIComponent(id)}/delete`, { method: "POST", body: {} }),
  saveTemplate: (template) => request("/templates", { method: "POST", body: template }),
  deleteTemplate: (id) => request(`/templates/${encodeURIComponent(id)}/delete`, { method: "POST", body: {} }),

  // Files
  localFolder: (path) => request("/local-folder", { method: "POST", body: { path } }),
  files: (sandbox, path) => request(`/files/${encodeURIComponent(sandbox)}?path=${encodeURIComponent(path)}`),
  seed: (sandbox) => request(`/files/${encodeURIComponent(sandbox)}/seed`),
  retrySeed: (sandbox) => request(`/files/${encodeURIComponent(sandbox)}/seed/retry`, { method: "POST", body: {} }),
  prepareDownload: (sandbox, path) => request(`/files/${encodeURIComponent(sandbox)}/download`, { method: "POST", body: { path } }),
  startUpload: (sandbox) => request(`/files/${encodeURIComponent(sandbox)}/uploads`, { method: "POST", body: {} }),
  uploadFile: (sandbox, id, filePath, file, uploadSignal) => request(`/files/${encodeURIComponent(sandbox)}/uploads/${id}?path=${encodeURIComponent(filePath)}`, { method: 'POST', body: file, raw: true, signal: uploadSignal }),
  commitUpload: (sandbox, id, dir) => request(`/files/${encodeURIComponent(sandbox)}/uploads/${id}/commit`, { method: "POST", body: { dir } }),
  cancelUpload: (sandbox, id) => request(`/files/${encodeURIComponent(sandbox)}/uploads/${id}/cancel`, { method: "POST", body: {} }),

  // Ingress
  ingress: () => request("/ingress"),
  exposeService: (body) => request("/ingress/expose", { method: "POST", body }),
  closeService: (service) => request("/ingress/close", { method: "POST", body: { sandbox: service.sandbox, name: service.name } }),
  extendService: (service, closeAfterMinutes) => request("/ingress/extend", { method: "POST", body: { sandbox: service.sandbox, name: service.name, closeAfterMinutes } }),
}
}

export const api = createApi()
