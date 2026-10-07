import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { composeTemplate } from '../shared/policy-templates.js'

const fail = (message, status = 400) => Object.assign(new Error(message), { status })

// One atomic catalog overlay stores edits and deletions, including built-ins.
// Existing custom JSON files remain readable and are never rewritten by migration.
export function createTemplateStore({ directory, builtins, legacy = [], validate }) {
  const statePath = path.join(directory, 'catalog', 'templates.json')
  let pending = Promise.resolve()
  const mutate = (operation) => {
    const next = pending.then(operation)
    pending = next.catch(() => {})
    return next
  }
  async function state() {
    try { return JSON.parse(await fs.readFile(statePath, 'utf8')) }
    catch (error) { if (error.code === 'ENOENT') return { templates: {}, deleted: [] }; throw error }
  }
  async function write(value) {
    await fs.mkdir(path.dirname(statePath), { recursive: true })
    const temporary = `${statePath}.${randomUUID()}.tmp`
    try {
      await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`)
      await fs.rename(temporary, statePath)
    } finally { await fs.rm(temporary, { force: true }) }
  }
  async function list(current = null) {
    current ??= await state()
    const catalog = new Map(builtins.map(template => [template.id, template]))
    let files = []
    try { files = await fs.readdir(directory) } catch (error) { if (error.code !== 'ENOENT') throw error }
    for (const file of files.filter(name => name.endsWith('.json'))) {
      try {
        const template = validate(JSON.parse(await fs.readFile(path.join(directory, file), 'utf8')))
        if (!catalog.has(template.id)) catalog.set(template.id, template)
      } catch { /* Ignore malformed legacy custom files, as before. */ }
    }
    for (const value of Object.values(current.templates)) {
      const template = validate(value)
      catalog.set(template.id, template)
    }
    for (const id of current.deleted) catalog.delete(id)
    return [...catalog.values()]
  }
  async function groups() {
    const folder = path.join(directory, 'org', 'groups')
    let files
    try { files = await fs.readdir(folder) } catch (error) { if (error.code === 'ENOENT') return []; throw error }
    return Promise.all(files.filter(file => file.endsWith('.json')).map(async file => JSON.parse(await fs.readFile(path.join(folder, file), 'utf8'))))
  }
  return {
    list,
    async find(id) {
      const current = await state()
      if (current.deleted.includes(id)) return null
      return (await list(current)).find(template => template.id === id) ?? legacy.find(template => template.id === id) ?? null
    },
    save: (input) => mutate(async () => {
      const template = validate(input)
      const current = await state()
      if (input.isNew && (await list(current)).some(item => item.id === template.id)) throw fail('A policy with this id already exists. Pick another identity.', 409)
      const catalog = (await list(current)).filter(item => item.id !== template.id).concat(template)
      // An edited addition must also remain compatible with saved combinations.
      for (const item of catalog) {
        try { composeTemplate(item, [], catalog) }
        catch (error) { throw fail(`${item.name}: ${error.message}`) }
      }
      current.templates[template.id] = template
      current.deleted = current.deleted.filter(id => id !== template.id)
      await write(current)
      return template
    }),
    deleteMany: (ids) => mutate(async () => {
      if (!Array.isArray(ids) || !ids.length || ids.length > 200 || ids.some(id => typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,47}$/.test(id))) throw fail('Choose policies to delete.')
      const targets = new Set(ids)
      const current = await state()
      const catalog = await list(current)
      for (const template of catalog.filter(item => !targets.has(item.id))) {
        if (template.accessTemplates?.some(id => targets.has(id))) throw fail(`"${template.name}" uses a selected policy. Edit it or include it in the deletion.`, 409)
      }
      for (const group of await groups()) {
        if (targets.has(group.template)) throw fail(`Group "${group.name || group.id}" uses a selected policy. Change the group's policy first.`, 409)
      }
      current.deleted = [...new Set([...current.deleted, ...targets])]
      for (const id of targets) delete current.templates[id]
      await write(current)
      return { deleted: [...targets] }
    }),
  }
}
