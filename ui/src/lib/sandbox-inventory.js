import {createApi} from './api.js'

export function sandboxInventoryKey(sandbox) {
  if (!['local','cloud'].includes(sandbox.computeTarget)) throw Error('Unknown sandbox location')
  return `${sandbox.computeTarget}:${sandbox.id ?? sandbox.name}`
}
export function mergeSandboxInventories({local = [], cloud = []}) {
  return Object.entries({local,cloud}).flatMap(([computeTarget,sandboxes]) => (sandboxes ?? []).map(sandbox => ({...sandbox,computeTarget})))
}
export function sandboxInventoryApi(sandbox, localViewer, signal) {
  sandboxInventoryKey(sandbox)
  return createApi(localViewer ? sandbox.computeTarget : 'local', signal)
}
