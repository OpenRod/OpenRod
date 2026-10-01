import { api } from './api.js'
import { createSetupImportJobs } from './setup-import-jobs.js'

export const setupImports = createSetupImportJobs(api)

const targetJobs = new WeakMap()
export function importsForApi(selectedApi) {
  if (!targetJobs.has(selectedApi)) targetJobs.set(selectedApi, createSetupImportJobs(selectedApi))
  return targetJobs.get(selectedApi)
}
