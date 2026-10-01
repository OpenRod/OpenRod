import fs from 'node:fs'
import { SETUP_AGENTS } from '../shared/setup-targets.js'

// Embed the trusted catalog: scripts also run via python -c in the sandbox,
// where the console's source files are not present.
export function setupPython(filename) {
  return `SETUP_TARGET_CATALOG = ${JSON.stringify(JSON.stringify(SETUP_AGENTS))}\n` + fs.readFileSync(new URL('./setup-json.py', import.meta.url), 'utf8') + '\n' + fs.readFileSync(new URL(filename, import.meta.url), 'utf8')
}
