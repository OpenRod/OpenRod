import { newRecipe } from './image-templates.js'
import { prepareQuickSetups } from './quick-setup.js'

export async function buildTemplateWithSetups(api, recipe, replace, options = {}) {
  const prepared = await prepareQuickSetups(api, recipe.setups || [], null, {
    ...options, expectedRevisions: recipe.setupRevisions,
  })
  if (options.signal?.aborted) throw new DOMException('Preparation cancelled.', 'AbortError')
  const pinned = newRecipe({
    ...recipe,
    setups: prepared.setups.map(s => s.id),
    setupRevisions: Object.fromEntries(prepared.setups.map(s => [s.id, s.revision])),
  })
  options.onPrepared?.()
  options.onProgress?.('Starting image build…')
  return api.buildImageTemplate(pinned, replace)
}
