import test from 'node:test'
import assert from 'node:assert/strict'
import { nameSandboxImages, IMAGE_TEMPLATE_NAME } from './sandbox-images.js'
import { imageName } from './sandboxes.js'
const templates = [{ name: 'claude-workspace', image: 'openshell-template/claude-workspace:a1' }]
test('names sandboxes by the template the gateway recorded, without changing the image', () => {
 const [box] = nameSandboxImages([{ image: 'openshell-template/claude-workspace:a1', workloadTemplate: 'claude-workspace' }], templates)
 assert.equal(box.imageTemplateName, 'claude-workspace')
 assert.equal(box.image, 'openshell-template/claude-workspace:a1')
 assert.equal(imageName(box.image, box.imageTemplateName), 'claude-workspace')
})
test('the captured name survives the template being deleted', () => {
 const box = { image: 'openshell-template/old:a0', labels: { [IMAGE_TEMPLATE_NAME]: 'old' } }
 assert.equal(nameSandboxImages([box], [])[0].imageTemplateName, 'old')
})
test('matches a unique template image but does not guess for shared or missing ones', () => {
 assert.equal(nameSandboxImages([{ image: 'openshell-template/claude-workspace:a1' }], templates)[0].imageTemplateName, 'claude-workspace')
 const shared = [...templates, { name: 'other', image: 'openshell-template/claude-workspace:a1' }]
 assert.equal(nameSandboxImages([{ image: 'openshell-template/claude-workspace:a1' }], shared)[0].imageTemplateName, null)
 assert.equal(nameSandboxImages([{ image: 'node:22' }], templates)[0].imageTemplateName, null)
 assert.equal(imageName('node:22'), 'node:22')
 assert.equal(imageName('sha256:' + 'a'.repeat(64)), 'Unknown template')
})

test('VS Code Server is labeled at creation and shown from the label or the template recipe', async () => {
  const { TOOLS_LABEL, imageTemplateLabels, hasVscodeServer, sandboxTools } = await import('./sandbox-images.js')
  const code = { name: 'code', managed: true, image: 'openshell-template/code:a1', recipe: { source: 'build', agents: ['claude'], runtimes: ['node', 'vscode'] } }
  const plain = { name: 'plain', managed: true, image: 'openshell-template/plain:a1', recipe: { source: 'build', agents: ['claude'], runtimes: ['node'] } }
  assert.deepEqual(imageTemplateLabels(code), { [IMAGE_TEMPLATE_NAME]: 'code', [TOOLS_LABEL]: 'vscode' })
  assert.deepEqual(imageTemplateLabels(plain), { [IMAGE_TEMPLATE_NAME]: 'plain' })
  assert.deepEqual(imageTemplateLabels({ ...code, managed: false }), { [IMAGE_TEMPLATE_NAME]: 'code' })
  assert.deepEqual(imageTemplateLabels(null), {})
  // The label wins over the template, which may have been edited since.
  assert.deepEqual(sandboxTools({ labels: { [TOOLS_LABEL]: '' } }, code), [])
  const [labeled, fromRecipe, without, unknown] = nameSandboxImages([
    { name: 'a', image: 'x', labels: { [TOOLS_LABEL]: 'vscode' } },
    { name: 'b', image: code.image, labels: {} },
    { name: 'c', image: plain.image, labels: {} },
    { name: 'd', image: 'custom:latest', labels: {} },
  ], [code, plain])
  assert.deepEqual([labeled, fromRecipe, without, unknown].map(hasVscodeServer), [true, true, false, false])
  assert.equal(hasVscodeServer({ labels: { [TOOLS_LABEL]: 'vscode' } }), true)
  assert.equal(hasVscodeServer(null), false)
})
