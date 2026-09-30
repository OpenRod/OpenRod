export const IMAGE_TEMPLATE_ID = 'openshell.console/image-template'
export const IMAGE_TEMPLATE_NAME = 'openshell.console/image-template-name'
const NAME_PARTS = `${IMAGE_TEMPLATE_NAME}-parts`
const NAME_PART = `${IMAGE_TEMPLATE_NAME}-`

// Gateway label values are restricted to ASCII identifier characters and 63
// bytes. Keep the display name intact in bounded UTF-8 hex chunks, including
// when its template is later deleted. Never use a human name as a raw label.
export function imageTemplateLabels(template) {
  const hex = Array.from(new TextEncoder().encode(template.recipe.name), (byte) => byte.toString(16).padStart(2, '0')).join('')
  const parts = hex.match(/.{1,60}/g) ?? []
  return {
    [IMAGE_TEMPLATE_ID]: template.id,
    [NAME_PARTS]: String(parts.length),
    ...Object.fromEntries(parts.map((part, i) => [`${NAME_PART}${i}`, part])),
  }
}

function capturedName(labels) {
  const count = Number(labels[NAME_PARTS])
  if (Number.isInteger(count) && count > 0 && count <= 16) {
    const parts = Array.from({ length: count }, (_, i) => labels[`${NAME_PART}${i}`])
    if (parts.every((part) => typeof part === 'string' && /^(?:[0-9a-f]{2}){1,30}$/.test(part))) {
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(parts.join('').match(/../g), (byte) => parseInt(byte, 16)))
      } catch { /* Fall back to legacy labels if a snapshot is malformed. */ }
    }
  }
  return labels[IMAGE_TEMPLATE_NAME] || null
}

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
    const name = byId.get(id) || capturedName(labels) || (!id && matches?.size === 1 ? [...matches][0] : null)
    return { ...sandbox, imageTemplateName: name || null }
  })
}
