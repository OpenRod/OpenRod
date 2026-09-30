import test from 'node:test'
import assert from 'node:assert/strict'
import { nameSandboxImages, IMAGE_TEMPLATE_ID, IMAGE_TEMPLATE_NAME } from './sandbox-images.js'
import { imageName } from './sandboxes.js'
const templates = [{ id: 'a', recipe: { name: 'Claude workspace' }, inspection: { imageId: 'sha256:a' } }]
test('resolves existing image IDs without changing the launch reference', () => {
 const [box] = nameSandboxImages([{ image: 'sha256:a' }], templates)
 assert.equal(box.imageTemplateName, 'Claude workspace')
 assert.equal(box.image, 'sha256:a')
 assert.equal(imageName(box.image, box.imageTemplateName), 'Claude workspace')
})
test('explicit identity survives rebuilds and captured name survives deletion', () => {
 const box = { image: 'sha256:old', labels: { [IMAGE_TEMPLATE_ID]: 'a', [IMAGE_TEMPLATE_NAME]: 'Original name' } }
 assert.equal(nameSandboxImages([box], templates)[0].imageTemplateName, 'Claude workspace')
 assert.equal(nameSandboxImages([box], [])[0].imageTemplateName, 'Original name')
})
test('does not guess for ambiguous or missing legacy images', () => {
 const ambiguous = [...templates, { id: 'b', recipe: { name: 'Other' }, inspection: { imageId: 'sha256:a' } }]
 assert.equal(nameSandboxImages([{ image: 'sha256:a' }], ambiguous)[0].imageTemplateName, null)
 assert.equal(nameSandboxImages([{ image: 'sha256:missing' }], templates)[0].imageTemplateName, null)
 assert.equal(imageName('node:22'), 'node:22')
 assert.equal(imageName('sha256:' + 'a'.repeat(64)), 'Unknown template')
})

test('display names round-trip through gateway-safe labels, including after deletion', async () => {
 const { imageTemplateLabels } = await import('./sandbox-images.js')
 for (const name of ['Gemini CLI', 'Claude / Codex (dev)', 'תבנית 🚀', '界'.repeat(80)]) {
  const labels = imageTemplateLabels({ id: 'template-id', recipe: { name } })
  assert.equal(labels[IMAGE_TEMPLATE_ID], 'template-id')
  for (const value of Object.values(labels)) {
   assert.match(value, /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/)
   assert(value.length <= 63)
  }
  assert.equal(nameSandboxImages([{ labels }], [])[0].imageTemplateName, name)
 }
})

test('incomplete name snapshots are ignored without breaking fleet rendering', () => {
 const labels = { [IMAGE_TEMPLATE_ID]: 'missing', [`${IMAGE_TEMPLATE_NAME}-parts`]: '2', [`${IMAGE_TEMPLATE_NAME}-0`]: '47' }
 assert.equal(nameSandboxImages([{ labels }], [])[0].imageTemplateName, null)
})
