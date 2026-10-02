import { TOOL_ACCESS } from '../../shared/agent-access.js'

// Kept on sandboxes launched from an image template, so the name survives
// the template's deletion.
export const IMAGE_TEMPLATE_NAME = 'openshell.console/image-template-name'
// Image tools (such as VS Code Server) chosen at creation, comma-separated.
export const TOOLS_LABEL = 'openshell.console/tools'
export const recipeTools = (recipe) => recipe?.source === 'build' ? [...new Set(recipe.runtimes ?? [])].filter((id) => TOOL_ACCESS[id]) : []
export function imageTemplateLabels(template) {
  if (!template) return {}
  const tools = template.managed ? recipeTools(template.recipe) : []
  return { [IMAGE_TEMPLATE_NAME]: template.name, ...(tools.length ? { [TOOLS_LABEL]: tools.join(',') } : {}) }
}
// The label is authoritative; older sandboxes fall back to their template's recipe.
export function sandboxTools(sandbox, template) {
  const label = sandbox?.labels?.[TOOLS_LABEL]
  if (typeof label === 'string') return label.split(',').filter((id) => TOOL_ACCESS[id])
  return template?.managed ? recipeTools(template.recipe) : []
}
export const hasVscodeServer = (sandbox) => Boolean(sandbox?.tools?.includes('vscode') || sandbox?.labels?.[TOOLS_LABEL]?.split(',').includes('vscode'))

// Resolve the whole fleet once. The gateway records the template a sandbox
// came from; otherwise use the name label, or a unique template whose image
// matches, rather than guessing between shared images.
export function nameSandboxImages(sandboxes, templates) {
  const byImage = new Map(), byName = new Map(templates.map((template) => [template.name, template]))
  for (const template of templates) {
    if (!template.image) continue
    const names = byImage.get(template.image) ?? new Set()
    names.add(template.name)
    byImage.set(template.image, names)
  }
  return sandboxes.map((sandbox) => {
    const matches = byImage.get(sandbox.image)
    const name = sandbox.workloadTemplate || sandbox.labels?.[IMAGE_TEMPLATE_NAME] || (matches?.size === 1 ? [...matches][0] : null)
    return { ...sandbox, imageTemplateName: name || null, tools: sandboxTools(sandbox, name ? byName.get(name) : null) }
  })
}
