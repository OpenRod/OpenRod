#!/usr/bin/env node
'use strict'
// OpenSSH invokes this helper locally. Grants remain inside OpenRod's local server;
// this process obtains only a single-use, account-scoped SSH stream ticket.
const fs = require('node:fs/promises')
const { WebSocket, createWebSocketStream } = require('ws')

function validate(options) {
  const url = new URL(options.origin)
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.origin !== options.origin || url.username || url.password || !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(options.sandbox ?? '') || !/^[a-f0-9]{16}$/.test(options.owner ?? '')) throw Error('Invalid local OpenRod SSH target')
  if (options.context !== undefined) {
    let context
    try { context = JSON.parse(options.context) } catch { throw Error('Invalid OpenRod SSH workspace') }
    if (!Array.isArray(context) || context.length !== 2 || !context.every(value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value))) throw Error('Invalid OpenRod SSH workspace')
  }
  return options
}
function parseProxyArgs(args) {
  const options = {}
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]
    if (!['--origin', '--sandbox', '--owner', '--context', '--auth-file'].includes(flag) || !args[i + 1] || Object.hasOwn(options, flag.slice(2))) throw Error('Invalid OpenRod SSH proxy arguments')
    options[flag.slice(2)] = args[i + 1]
  }
  return validate(options)
}
async function runProxy(options, { input = process.stdin, output = process.stdout, fetchRequest = fetch, signal } = {}) {
  validate(options)
  let cookie
  if (options['auth-file']) {
    try {
      const file = await fs.open(options['auth-file'], require('node:fs').constants.O_RDONLY | require('node:fs').constants.O_NOFOLLOW)
      try {
        const stat = await file.stat()
        if (!stat.isFile() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid()) || stat.size > 4096) throw Error('Invalid credential file')
        const auth = JSON.parse(await file.readFile('utf8'))
        if (auth.origin !== options.origin || typeof auth.cookie !== 'string' || !/^openrod_token_[0-9]+=[A-Za-z0-9_-]{32,256}$/.test(auth.cookie)) throw Error('Invalid credential')
        cookie = auth.cookie
      } finally { await file.close() }
    } catch { throw Error('Local OpenRod SSH credentials are unavailable. Open the sandbox from OpenRod again.') }
  }
  const response = await fetchRequest(`${options.origin}/api/remote/os/sandboxes/${options.sandbox}/ssh-ticket`, {
    method: 'POST', headers: { ...(cookie ? { Cookie: cookie } : {}), 'x-openrod-local-owner': options.owner, Origin: options.origin, 'content-type': 'application/json', 'x-openshell-console': '1' },
    body: JSON.stringify({ owner: options.owner, ...(options.context ? { context: options.context } : {}) }), redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
  })
  if (!response.ok) {
    const error = await response.json().catch(() => ({}))
    if (error.code === 'CONSOLE_TOKEN_REQUIRED') throw Error('Local OpenRod console authorization expired. Open the sandbox from OpenRod again.')
    throw Error(`Local OpenRod SSH authorization failed (${response.status}). Reconnect to OpenRod Cloud.`)
  }
  const body = await response.json()
  if (typeof body.ticket !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(body.ticket)) throw Error('Invalid SSH ticket from local OpenRod')
  const url = new URL('/api/remote/os/ssh', options.origin); url.protocol = 'ws:'; url.searchParams.set('ticket', body.ticket); url.searchParams.set('owner', options.owner)
  if (options.context) url.searchParams.set('context', options.context)
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { origin: options.origin, headers: cookie ? { Cookie: cookie } : {}, handshakeTimeout: 30000, maxPayload: 1024 * 1024 })
    let stream, settled = false
    const abort = () => { ws.terminate(); finish(Error('OpenRod SSH connection canceled')) }
    const finish = error => {
      if (settled) return; settled = true
      signal?.removeEventListener('abort', abort)
      input.off('error', inputError); output.off('error', outputError)
      if (stream) { input.unpipe(stream); stream.unpipe(output); stream.destroy() }
      if (error) { ws.terminate(); reject(error) } else resolve()
    }
    const inputError = () => finish(Error('SSH input closed unexpectedly'))
    const outputError = () => finish(Error('SSH output closed unexpectedly'))
    input.on('error', inputError); output.on('error', outputError)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) return abort()
    ws.once('open', () => {
      stream = createWebSocketStream(ws)
      stream.on('error', () => finish(Error('OpenRod SSH stream disconnected')))
      stream.pipe(output, { end: false }); input.pipe(stream)
    })
    ws.on('message', (_data, binary) => { if (!binary) finish(Error('Invalid SSH stream frame')) })
    ws.once('error', () => finish(Error('Could not connect to the OpenRod SSH stream. Reconnect to OpenRod Cloud.')))
    ws.once('close', code => {
      const error = [1000, 1005].includes(code) ? undefined : Error('OpenRod SSH connection ended. Reconnect to OpenRod Cloud.')
      if (error || !stream || stream.readableEnded) finish(error)
      else stream.once('end', () => finish())
    })
  })
}
module.exports = { parseProxyArgs, runProxy }
if (require.main === module) {
  const abort = new AbortController()
  process.once('SIGINT', () => abort.abort()); process.once('SIGTERM', () => abort.abort())
  Promise.resolve().then(() => runProxy(parseProxyArgs(process.argv.slice(2)), { signal: abort.signal }))
    .catch(error => { process.stderr.write(`OpenRod SSH: ${error.message}\n`); process.exitCode = 1 })
}
