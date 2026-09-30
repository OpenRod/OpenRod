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
