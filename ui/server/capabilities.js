import { CLOUD_TRANSFER_LIMIT, CLOUD_TRANSFER_BODY_LIMIT } from './cloud-transfer.js'

// Explicit support, rather than environment names, drives available UI actions.
export function consoleCapabilities(mode = 'local') {
  const cloud = mode !== 'local'
  return {
    version: 1,
    mode,
    resources: Object.fromEntries(['sandboxes', 'templates', 'setups', 'network', 'groups', 'secrets', 'activity'].map(type => [type, { read: true, manage: true }])),
    features: { terminal: true, files: true, templateBuilds: true, localFolders: !cloud, publicIngress: !cloud, resourceImports: true },
    workspaceTransfer: { supported: true, maxBytes: CLOUD_TRANSFER_LIMIT, maxFiles: 2000, maxRequestBytes: CLOUD_TRANSFER_BODY_LIMIT, preservesSource: true, credentials: false, runningProcesses: false },
  }
}
