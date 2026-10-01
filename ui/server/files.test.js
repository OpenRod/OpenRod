import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { Readable } from 'node:stream'

// The folder rules are relative to the home folder, so give the module its own.
const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'openshell-files-test-')))
process.env.HOME = home
const { localFolder, parseListing, planSeed, sandboxPath, filesRoute, receiveUpload } = await import('./files.js')
const { runWithContext } = await import('./gateway.js')
after(() => fs.rm(home, { recursive: true, force: true }))

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd, stdio: 'pipe' })
async function write(file, content = 'x') {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content)
}

test('sandbox paths stay under /sandbox', () => {
  assert.equal(sandboxPath('/sandbox/app/'), '/sandbox/app')
  assert.equal(sandboxPath('/sandbox/a/../b'), '/sandbox/b')
  assert.equal(sandboxPath(undefined), '/sandbox')
  assert.throws(() => sandboxPath('/sandbox/../etc'), /Only \/sandbox/)
  assert.throws(() => sandboxPath('/sandboxes'), /Only \/sandbox/)
  assert.throws(() => sandboxPath('app'), /absolute/)
})

test('a listing is parsed from stat lines and symlink triples, with names that hold newlines', () => {
  const stat = ['directory|4096|1700000000|/sandbox/app', 'regular file|5|1700000001|/sandbox/a.txt', 'regular empty file|0|1700000002|/sandbox/two', 'lines', 'symbolic link|9|1700000003|/sandbox/l'].join('\n')
  const listing = parseListing(['/sandbox', '2048', `${stat}\n`, '/sandbox/l', '/etc/hosts', 'regular file', ''])
  assert.equal(listing.free, 2048 * 1024)
  assert.deepEqual(listing.entries.map((e) => [e.name, e.type, e.size, e.target, e.targetType]), [
    ['app', 'dir', null, null, null], ['a.txt', 'file', 5, null, null], ['l', 'link', null, '/etc/hosts', 'file'], ['two\nlines', 'file', 0, null, null],
  ])
  assert.equal(listing.truncated, false)
})

test('a repository sends what git would: tracked and untracked, minus ignored, plus history', async () => {
  const repo = path.join(home, 'code', 'app')
  await write(path.join(repo, '.gitignore'), 'node_modules/\n')
  await write(path.join(repo, 'src', 'index.js'), 'hello')
  await write(path.join(repo, 'node_modules', 'dep', 'index.js'), 'ignored')
  git(repo, 'init', '-q'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'init')
  await write(path.join(repo, '.env'), 'TOKEN=fake')
  await fs.symlink('/etc/hosts', path.join(repo, 'hosts'))

  const plan = await localFolder('~/code/app')
  assert.equal(plan.display, '~/code/app')
  assert.equal(plan.dest, '/sandbox/app')
  assert.equal(plan.project, 'app')
  assert.equal(plan.filter, 'gitignore')
  assert.equal(plan.files, 4) // .gitignore, src/index.js, .env, hosts
  assert.equal(plan.links, 1)
  assert.equal(plan.bytes, 'node_modules/\n'.length + 'hello'.length + 'TOKEN=fake'.length)
  assert.equal(plan.git, 'included')
  assert.ok(plan.gitBytes > 0)
  assert.deepEqual(plan.secrets, ['.env'])
  assert.equal(plan.over, false)

  // A worktree's .git is a pointer file, so its history cannot travel.
  git(repo, 'worktree', 'add', '-q', path.join(home, 'code', 'app-wt'))
  assert.equal((await localFolder(path.join(home, 'code', 'app-wt'))).git, 'worktree')
  assert.equal((await localFolder('~/code/app/src')).git, 'subfolder')
})

test('a plain folder sends everything', async () => {
  await write(path.join(home, 'notes', 'a.md'), 'aa')
  await write(path.join(home, 'notes', 'deep', 'b.md'), 'bbb')
  const plan = await localFolder('~/notes')
  assert.deepEqual([plan.filter, plan.git, plan.files, plan.bytes], ['none', 'none', 2, 5])
})

test('home, hidden folders and anything outside home are refused', async () => {
  await fs.mkdir(path.join(home, '.ssh'), { recursive: true })
  await write(path.join(home, 'file.txt'))
  await assert.rejects(localFolder('~'), /inside your home/)
  await assert.rejects(localFolder('~/.ssh'), /Hidden folders/)
  await assert.rejects(localFolder('~/.config/openshell'), /does not exist|Hidden folders/)
  await assert.rejects(localFolder(os.tmpdir()), /inside your home/)
  await assert.rejects(localFolder('~/file.txt'), /not a file/)
  await assert.rejects(localFolder('relative/path'), /full path/)
  await fs.symlink(path.join(home, '.ssh'), path.join(home, 'keys'))
  await assert.rejects(localFolder('~/keys'), /Hidden folders/)
})

test('repositories: public https only, cloned into a folder named after the repo', async () => {
  assert.deepEqual(await planSeed({ repository: 'https://github.com/octocat/Hello-World.git' }), {
    kind: 'repository', source: 'https://github.com/octocat/Hello-World.git', dest: '/sandbox/Hello-World', project: 'Hello-World',
    repo: { url: 'https://github.com/octocat/Hello-World.git', name: 'Hello-World', project: 'Hello-World', dest: '/sandbox/Hello-World' },
  })
  await assert.rejects(planSeed({ repository: 'git@github.com:o/r.git' }), /https/)
  await assert.rejects(planSeed({ repository: 'https://user:token@github.com/o/r' }), /credentials/)
  await assert.rejects(planSeed({ folder: '~/notes', repository: 'https://github.com/o/r' }), /not both/)
  assert.equal(await planSeed({}), null)
})

test('a staged upload cannot be received, committed, or cancelled in another context', async () => {
  const origin = { gateway: 'upload-one', workspace: 'alpha' }
  const others = [
    { gateway: 'upload-one', workspace: 'beta' },
    { gateway: 'upload-two', workspace: 'alpha' },
  ]
  const { id } = await runWithContext(origin, () => filesRoute('POST', ['files', 'same-name', 'uploads'], {}))
  const request = () => Object.assign(Readable.from([Buffer.from('hello')]), { headers: { 'content-length': '5' } })
  try {
    await runWithContext(origin, () => receiveUpload(request(), 'same-name', id, 'hello.txt'))
    for (const context of others) {
      await runWithContext(context, async () => {
        await assert.rejects(receiveUpload(request(), 'same-name', id, 'other.txt'), { status: 404 })
        for (const action of ['commit', 'cancel']) {
          await assert.rejects(filesRoute('POST', ['files', 'same-name', 'uploads', id, action], { dir: '/sandbox' }), { status: 404 })
        }
      })
    }
    await runWithContext(origin, () => receiveUpload(request(), 'same-name', id, 'still-owned.txt'))
  } finally {
    await runWithContext(origin, () => filesRoute('POST', ['files', 'same-name', 'uploads', id, 'cancel'], {}))
  }
})
