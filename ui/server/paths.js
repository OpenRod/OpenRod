import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { contextKey, contextSelection } from './gateway.js'

// Installed packages are read-only. All mutable console data lives with the user.
export function stateDirectory() {
  return path.resolve(process.env.OPENSHELL_CONSOLE_DATA_DIR || path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local/state'), 'openshell-console'))
}

export function scopedStateDirectory(context = contextSelection()) {
  const scope = createHash('sha256').update(contextKey(context)).digest('hex')
  return path.join(stateDirectory(), 'contexts', scope)
}

// Every context starts with empty policies: built-in templates live in code, and
// egress rules, groups and memberships are only ever authored by the operator.
const policyDirectories = new Map()
export async function policyDirectory() {
  const directory = path.join(scopedStateDirectory(), 'policies')
  if (!policyDirectories.has(directory)) {
    const ready = fs.mkdir(directory, { recursive: true, mode: 0o700 }).then(() => directory)
    policyDirectories.set(directory, ready)
    ready.catch(() => policyDirectories.delete(directory))
  }
  return policyDirectories.get(directory)
}
