import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { contextKey, contextSelection, resolveGateway } from './gateway.js'

// Installed packages are read-only. All mutable console data lives with the user.
export function stateDirectory() {
  return path.resolve(process.env.OPENSHELL_CONSOLE_DATA_DIR || path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local/state'), 'openshell-console'))
}

export function scopedStateDirectory(context = contextSelection()) {
  const scope = createHash('sha256').update(contextKey(context)).digest('hex')
  return path.join(stateDirectory(), 'contexts', scope)
}

const policyDirectories = new Map()
export async function policyDirectory() {
  const directory = path.join(scopedStateDirectory(), 'policies')
  if (!policyDirectories.has(directory)) {
    const context = contextSelection()
    const ready = (async () => {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 })
      const marker = path.join(directory, '.initialized')
      try { await fs.access(marker); return directory } catch (error) { if (error.code !== 'ENOENT') throw error }
      // Preserve a source checkout's policies only for the original local
      // gateway. These user-authored files are never included in npm packages.
      if (context.gateway === 'openshell' && context.workspace === 'default') {
        let local = false
        try {
          const target = resolveGateway(context.gateway)
          local = !target.remote && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(target.endpoint).hostname)
        } catch { /* No usable local registration to migrate. */ }
        if (local) {
          const source = path.resolve(import.meta.dirname, '../policies')
          try {
            await fs.cp(source, directory, { recursive: true, force: false, dereference: false,
              filter: async (file) => {
                const stat = await fs.lstat(file)
                return stat.isDirectory() || (stat.isFile() && path.extname(file) === '.json')
              },
            })
          } catch (error) { if (error.code !== 'ENOENT') throw error }
        }
      }
      await fs.writeFile(marker, '', { mode: 0o600 })
      return directory
    })()
    policyDirectories.set(directory, ready)
    ready.catch(() => policyDirectories.delete(directory))
  }
  return policyDirectories.get(directory)
}
