#!/usr/bin/env node
'use strict'
// OpenSSH invokes this helper locally. Grants remain inside OpenRod's local server;
// this process obtains only a single-use, account-scoped SSH stream ticket.
const { WebSocket, createWebSocketStream } = require('ws')

function validate(options) {
  const url = new URL(options.origin)
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.origin !== options.origin || url.username || url.password || !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(options.sandbox ?? '') || !/^[a-f0-9]{16}$/.test(options.owner ?? '')) throw Error('Invalid local OpenRod SSH target')
  return options
}
function parseProxyArgs(args) {
  const options = {}
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]
    if (!['--origin', '--sandbox', '--owner'].includes(flag) || !args[i + 1] || Object.hasOwn(options, flag.slice(2))) throw Error('Invalid OpenRod SSH proxy arguments')
    options[flag.slice(2)] = args[i + 1]
  }
  return validate(options)
}
async function runProxy(options, { input = process.stdin, output = process.stdout, fetchRequest = fetch, signal } = {}) {
  validate(options)
  const response = await fetchRequest(`${options.origin}/api/remote/os/sandboxes/${options.sandbox}/ssh-ticket`, {
    method: 'POST', headers: { Origin: options.origin, 'content-type': 'application/json', 'x-openshell-console': '1' },
    body: JSON.stringify({ owner: options.owner }), redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
  })
  if (!response.ok) throw Error(`Local OpenRod SSH authorization failed (${response.status}). Reconnect to OpenRod Cloud.`)
  const body = await response.json()
  if (typeof body.ticket !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(body.ticket)) throw Error('Invalid SSH ticket from local OpenRod')
  const url = new URL('/api/remote/os/ssh', options.origin); url.protocol = 'ws:'; url.searchParams.set('ticket', body.ticket)
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { origin: options.origin, handshakeTimeout: 30000, maxPayload: 1024 * 1024 })
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
