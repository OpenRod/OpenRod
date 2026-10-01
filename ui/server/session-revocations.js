import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
const digest = value => createHash('sha256').update(value).digest('hex')
export function createSessionRevocations(filename) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(filename)
  fs.chmodSync(filename, 0o600)
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS revoked (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL)')
  return {
    hasDigest: hash => Boolean(db.prepare('SELECT 1 FROM revoked WHERE hash=? AND expires>?').get(hash, Date.now())),
    has: cookie => Boolean(db.prepare('SELECT 1 FROM revoked WHERE hash=? AND expires>?').get(digest(cookie), Date.now())),
    add(cookie, expires) {
      db.prepare('DELETE FROM revoked WHERE expires<=?').run(Date.now())
      db.prepare('INSERT OR REPLACE INTO revoked VALUES (?, ?)').run(digest(cookie), expires)
    },
    close: () => db.close(),
  }
}
