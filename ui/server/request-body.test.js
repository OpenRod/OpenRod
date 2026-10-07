import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { readRequestBody } from './api.js'

test('import JSON preserves skill text split inside UTF-8 characters', async () => {
  const value = { content: 'שלום 🌤 — café' }
  const bytes = Buffer.from(JSON.stringify(value))
  assert.deepEqual(await readRequestBody(Readable.from([...bytes].map(value => Buffer.from([value])))), value)
})
test('JSON parsing rejects malformed encoding and bounds raw bytes', async () => {
  await assert.rejects(readRequestBody(Readable.from([Buffer.from('{"a":"'), Buffer.from([0xff]), Buffer.from('"}')])), { status: 400 })
  await assert.rejects(readRequestBody(Readable.from(['{invalid}'])), { status: 400 })
  await assert.rejects(readRequestBody(Readable.from(['{"a":"שלום"}']), 10), { status: 413 })
})
