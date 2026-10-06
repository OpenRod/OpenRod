import test from 'node:test'
import assert from 'node:assert/strict'
import { connectionHost } from './connection-host.js'

const connections = { hosts: [{ name: 'aws-ec2' }], active: { host: 'aws-ec2' }, job: { host: 'aws-ec2', status: 'needs-install' } }
test('a missing requested host never falls back to a different SSH host or its pending job', () => {
  assert.deepEqual(connectionHost(connections, 'gcp-test'), { host: 'gcp-test', job: null })
})
test('an explicit choice wins, and only its own pending job resumes', () => {
  assert.deepEqual(connectionHost(connections, 'gcp-test', 'aws-ec2'), { host: 'aws-ec2', job: connections.job })
})
test('a general connection dialog may resume the current pending host', () => {
  assert.deepEqual(connectionHost(connections), { host: 'aws-ec2', job: connections.job })
})
