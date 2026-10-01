import { api } from './api.js'
import { createSetupImportJobs } from './setup-import-jobs.js'

export const setupImports = createSetupImportJobs(api)
