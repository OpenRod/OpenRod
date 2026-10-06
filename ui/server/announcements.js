import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { stateDirectory } from './paths.js'

// Lives outside the npm package and browser origin, so npx upgrades, ports,
// and browser changes do not replay the announcement for this OS user. While
// cloud is unavailable it stays unclaimed for the release that offers it.
export async function claimCloudAnnouncement({ directory = stateDirectory(), user = 'local', available = true } = {}) {
  if (!available) return { show: false }
  const owner = createHash('sha256').update(user).digest('hex')
  const folder = path.join(directory, 'announcements', owner)
  await fs.mkdir(folder, { recursive: true, mode: 0o700 })
  try {
    const file = await fs.open(path.join(folder, 'cloud-v1.seen'), 'wx', 0o600)
    await file.close()
    return { show: true }
  } catch (error) {
    if (error.code === 'EEXIST') return { show: false }
    throw error
  }
}
