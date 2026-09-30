// Browser side of the console API. Every call is same-origin; the server
// holds the gateway certificate, so nothing here carries a credential.

async function request(path, { method = "GET", body } = {}) {
  const response = await fetch(`/api/os${path}`, {
    method,
    headers: method === "GET" ? undefined : { "content-type": "application/json", "x-openshell-console": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error ?? `Request failed (${response.status})`)
  return payload
}

export const api = {
  previewActivityDeletion: (body) => request('/activity/delete-preview', { method: 'POST', body }),
  deleteActivity: (token) => request('/activity/delete', { method: 'POST', body: { token } }),
  activityDestinations: () => request('/activity-destinations'),
  createActivityDestination: (body) => request('/activity-destinations', { method: 'POST', body }),
  activityDestinationAction: (id, action) => request(`/activity-destinations/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: {} }),
  overview: () => request("/overview"),
  sandbox: (name) => request(`/sandboxes/${encodeURIComponent(name)}`),
  activity: (options = {}) => request(`/activity?query=${encodeURIComponent(JSON.stringify(options))}`),
  create: (spec) => request("/sandboxes", { method: "POST", body: spec }),
  openTerminal: (name) => request(`/sandboxes/${encodeURIComponent(name)}/terminal`, { method: "POST", body: {} }),
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
  templates: () => request("/templates"),
  imageTemplates: () => request("/image-templates"),
  localImages: () => request("/image-templates/local-images"),
  buildImageTemplate: (recipe, replace = false) => request("/image-templates", { method: "POST", body: { recipe, replace } }),
  cancelImageBuild: (name) => request(`/image-templates/${encodeURIComponent(name)}/cancel`, { method: "POST", body: {} }),
  dismissImageBuild: (name) => request(`/image-templates/${encodeURIComponent(name)}/dismiss`, { method: "POST", body: {} }),
  deleteImageTemplate: (name) => request(`/image-templates/${encodeURIComponent(name)}/delete`, { method: "POST", body: {} }),
  org: () => request("/org"),
  saveOrg: (org) => request("/org", { method: "POST", body: org }),
  saveGroup: (group) => request("/org/groups", { method: "POST", body: group }),
  deleteGroup: (id) => request(`/org/groups/${encodeURIComponent(id)}/delete`, { method: "POST", body: {} }),
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
  uploadFile: async (sandbox, id, path, file, signal) => {
    const response = await fetch(`/api/os/files/${encodeURIComponent(sandbox)}/uploads/${id}?path=${encodeURIComponent(path)}`, {
      method: "POST", headers: { "content-type": "application/octet-stream", "x-openshell-console": "1" }, body: file, signal,
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(payload.error ?? `Upload failed (${response.status})`)
    return payload
  },
  commitUpload: (sandbox, id, dir) => request(`/files/${encodeURIComponent(sandbox)}/uploads/${id}/commit`, { method: "POST", body: { dir } }),
  cancelUpload: (sandbox, id) => request(`/files/${encodeURIComponent(sandbox)}/uploads/${id}/cancel`, { method: "POST", body: {} }),

  // Ingress
  ingress: () => request("/ingress"),
  exposeService: (body) => request("/ingress/expose", { method: "POST", body }),
  closeService: (service) => request("/ingress/close", { method: "POST", body: { sandbox: service.sandbox, name: service.name } }),
  extendService: (service, closeAfterMinutes) => request("/ingress/extend", { method: "POST", body: { sandbox: service.sandbox, name: service.name, closeAfterMinutes } }),
}
