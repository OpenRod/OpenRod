export const IMAGE_TEMPLATE_ID = 'openshell.console/image-template'
export const IMAGE_TEMPLATE_NAME = 'openshell.console/image-template-name'

// Resolve the whole fleet once. Old sandboxes have only an immutable image ID;
// use a unique matching template rather than guessing between shared images.
export function nameSandboxImages(sandboxes, templates) {
  const byId = new Map(templates.map((t) => [t.id, t.recipe.name]))
  const byImage = new Map()
  for (const template of templates) {
    const digest = template.inspection?.imageId
    if (!digest) continue
    const names = byImage.get(digest) ?? new Set()
    names.add(template.recipe.name)
    byImage.set(digest, names)
  }
  return sandboxes.map((sandbox) => {
    const labels = sandbox.labels ?? {}
    const id = labels[IMAGE_TEMPLATE_ID]
    const matches = byImage.get(sandbox.image)
    const name = byId.get(id) || labels[IMAGE_TEMPLATE_NAME] || (!id && matches?.size === 1 ? [...matches][0] : null)
    return { ...sandbox, imageTemplateName: name || null }
  })
}
