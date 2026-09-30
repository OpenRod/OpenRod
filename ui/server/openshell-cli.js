import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveGateway } from './gateway.js'

const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_OUTPUT_LIMIT = 64 * 1024
const SEARCH_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local/bin')]

export const fail = (message, status = 400) => Object.assign(new Error(message), { status })
const pathDirs = (env = process.env) => (env.PATH ?? '').split(path.delimiter).filter(Boolean)

export function findExecutable(binary, dirs = [...pathDirs(), ...SEARCH_DIRS]) {
  if (!binary) return null
  if (binary.includes(path.sep)) {
    try { fs.accessSync(binary, fs.constants.X_OK); return binary } catch { return null }
  }
  for (const dir of dirs) {
    const file = path.join(dir, binary)
    try { fs.accessSync(file, fs.constants.X_OK); return file } catch { /* next */ }
  }
  return null
}

export function openshellBinary(env = process.env) {
  return findExecutable(env.OPENSHELL_BIN || 'openshell', [...pathDirs(env), ...SEARCH_DIRS])
}

export const sshBinary = (env = process.env) => findExecutable('ssh', pathDirs(env))
export const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`
export const commandText = (executable, args) => [executable, ...args].map(shellQuote).join(' ')

function stop(child, signal) {
  try {
    if (child.pid && process.platform !== 'win32') process.kill(-child.pid, signal)
    else child.kill(signal)
  } catch { /* already gone */ }
}

// Run without a shell. Output is bounded, and a timeout stops the process group
// so ssh/ssh-proxy children cannot survive their openshell parent.
export function runCli(executable, args, {
  cwd,
  env = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  outputLimit = DEFAULT_OUTPUT_LIMIT,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      detached: process.platform !== 'win32',
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout = []
    const stderr = []
    let bytes = 0
    let timedOut = false
    let outputExceeded = false
    let settled = false
    let hardKill

    const append = (target, chunk) => {
      const remaining = outputLimit - bytes
      if (remaining > 0) target.push(chunk.subarray(0, remaining))
      bytes += chunk.length
      if (bytes > outputLimit && !outputExceeded) {
        outputExceeded = true
        stop(child, 'SIGTERM')
        hardKill = setTimeout(() => stop(child, 'SIGKILL'), 500)
      }
    }
    child.stdout.on('data', (chunk) => append(stdout, chunk))
    child.stderr.on('data', (chunk) => append(stderr, chunk))

    const timer = setTimeout(() => {
      timedOut = true
      stop(child, 'SIGTERM')
      hardKill = setTimeout(() => stop(child, 'SIGKILL'), 500)
    }, timeoutMs)

    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(hardKill)
      reject(error)
    })
    child.once('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(hardKill)
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timedOut,
        outputExceeded,
      })
    })
  })
}

export async function runOpenShell(args, options = {}) {
  const env = options.env ?? process.env
  const executable = openshellBinary(env)
  if (!executable) throw fail('The openshell CLI is not installed on this machine.', 409)
  const gateway = options.gateway ?? resolveGateway().name
  const result = await runCli(executable, ['--gateway', gateway, ...args], { ...options, env: { ...env, NO_COLOR: '1' } })
  return { ...result, executable, gateway }
}

// Only CLI operations that install managed SSH config use this queue.
let queue = Promise.resolve()
export function serializeCli(task) {
  const run = queue.then(task, task)
  queue = run.catch(() => {})
  return run
}

// miette may emit either a structured gateway message or a boxed error.
export function reasonFrom(output) {
  const text = String(output ?? '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
  const gateway = text.match(/message: "([^"]+)"/)?.[1]
  if (gateway) return gateway
  const lines = text.split('\n')
  const start = lines.findIndex((line) => line.includes('×'))
  if (start >= 0) {
    const message = [lines[start].slice(lines[start].indexOf('×') + 1)]
    for (const line of lines.slice(start + 1)) {
      const more = /^\s*│(.*)$/.exec(line)
      if (!more) break
      message.push(more[1])
    }
    return message.map((part) => part.trim()).filter(Boolean).join(' ')
  }
  const clean = lines.map((line) => line.trim()).filter(Boolean)
  return (clean.find((line) => /^error:/i.test(line)) ?? clean.at(-1))?.replace(/^error:\s*/i, '') || 'The openshell CLI failed.'
}
