import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

// The folder rules are relative to the home folder, so give the module its own.
const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'openshell-files-test-')))
process.env.HOME = home
const { cliError, localFolder, planSeed, sandboxPath } = await import('./files.js')
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

test('CLI errors keep the message and drop the box drawing', () => {
  const output = "Downloading…\nError:   × sandbox source path '/sandbox/l' resolves to '/etc/hosts',\n  │ outside the sandbox workspace (/sandbox)\n\n"
  assert.equal(cliError(output), "sandbox source path '/sandbox/l' resolves to '/etc/hosts', outside the sandbox workspace (/sandbox)")
  assert.equal(cliError('ssh: connect failed\n'), 'ssh: connect failed')
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
