import assert from 'node:assert/strict'
import test from 'node:test'
import { nodeSupported } from './cli.js'

test('requires Node.js 22.13 or newer', () => {
  for (const version of ['20.20.2', '22.12.0', '21.7.3', '18.20.4']) assert.equal(nodeSupported(version), false, version)
  for (const version of ['22.13.0', '22.23.3', '24.0.0', '25.2.1']) assert.equal(nodeSupported(version), true, version)
})
