// Kept on sandboxes launched from an image template, so the name survives
// the template's deletion.
export const IMAGE_TEMPLATE_NAME = 'openshell.console/image-template-name'

// Resolve the whole fleet once. The gateway records the template a sandbox
// came from; otherwise use the name label, or a unique template whose image
// matches, rather than guessing between shared images.
export function nameSandboxImages(sandboxes, templates) {
  const byImage = new Map()
  for (const template of templates) {
    if (!template.image) continue
    const names = byImage.get(template.image) ?? new Set()
    names.add(template.name)
    byImage.set(template.image, names)
  }
  return sandboxes.map((sandbox) => {
    const matches = byImage.get(sandbox.image)
    const name = sandbox.workloadTemplate || sandbox.labels?.[IMAGE_TEMPLATE_NAME] || (matches?.size === 1 ? [...matches][0] : null)
    return { ...sandbox, imageTemplateName: name || null }
  })
}
