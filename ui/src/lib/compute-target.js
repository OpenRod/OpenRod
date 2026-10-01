export const COMPUTE_KEY = 'openrod.compute-target'
export function initialComputeTarget(url, storage) {
  const location = new URL(url)
  if (location.hash.startsWith('#cloud-return=')) return 'local'
  const pin = location.searchParams.get('target')
  if (pin === 'local' || pin === 'cloud') return pin
  try { return storage?.getItem(COMPUTE_KEY) === 'cloud' ? 'cloud' : 'local' } catch { return 'local' }
}
export function computeApiPath(target, path) {
  if (!['local', 'cloud'].includes(target)) throw new Error('Unknown compute target')
  return `${target === 'cloud' ? '/api/remote/os' : '/api/os'}${path}`
}
let target = 'local'
export const currentComputeTarget = () => target
export function setComputeTarget(value) {
  if (!['local', 'cloud'].includes(value)) throw new Error('Unknown compute target')
  target = value
}
export const computeStorageKey = (key, selected = currentComputeTarget()) => `${key}:${selected}`
export function pendingComputeRecipe(key, storage, selected = currentComputeTarget()) {
  try {
    const saved = JSON.parse(storage.getItem(computeStorageKey(key, selected)) ?? (selected === 'local' ? storage.getItem(key) : null))
    return saved?.recipe && typeof saved.recipe.name === 'string' ? saved : null
  } catch { return null }
}
export function saveComputeRecipe(key, value, storage, selected = currentComputeTarget()) {
  storage.setItem(computeStorageKey(key, selected), JSON.stringify(value))
  if (selected === 'local') storage.removeItem(key)
}
export function clearComputeRecipe(key, storage, selected = currentComputeTarget()) {
  storage.removeItem(computeStorageKey(key, selected))
  if (selected === 'local') storage.removeItem(key)
}

// First sign-in can complete an already-open cloud copy dialog. Retire its
// session only when an existing authenticated owner leaves or is replaced.
export function advanceComputeOwner(previous, uid) {
  const next = uid ?? null
  return { uid: next, revision: previous.revision + (previous.uid && previous.uid !== next ? 1 : 0) }
}

let cloudOwner = null
export const currentCloudOwner = () => cloudOwner
export function setCloudOwner(value) {
  cloudOwner = typeof value === 'string' && /^[a-f0-9]{16}$/.test(value) ? value : null
}
