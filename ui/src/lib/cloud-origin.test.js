import assert from 'node:assert/strict'
import test from 'node:test'

let importVersion = 0
async function configuredOrigin(value) {
  const previous = globalThis.__OPENROD_CLOUD_ORIGIN__
  try {
    if (value === undefined) delete globalThis.__OPENROD_CLOUD_ORIGIN__
    else globalThis.__OPENROD_CLOUD_ORIGIN__ = value
    return await import(`./cloud-origin.js?configuration=${++importVersion}`)
  } finally {
    if (previous === undefined) delete globalThis.__OPENROD_CLOUD_ORIGIN__
    else globalThis.__OPENROD_CLOUD_ORIGIN__ = previous
  }
}

test('frontend uses the hosted console when no build override exists', async () => {
  const { CLOUD_ORIGIN, CLOUD_AVAILABLE } = await configuredOrigin(undefined)
  assert.equal(CLOUD_ORIGIN, 'https://console.openrod.io')
  assert.equal(CLOUD_AVAILABLE, true)
})

test('frontend preserves custom cloud endpoints and explicit disabling', async () => {
  assert.equal((await configuredOrigin('https://cloud.example.test')).CLOUD_ORIGIN, 'https://cloud.example.test')
  const disabled = await configuredOrigin('')
  assert.equal(disabled.CLOUD_ORIGIN, '')
  assert.equal(disabled.CLOUD_AVAILABLE, false)
  for (const invalid of ['http://cloud.example.test', 'https://cloud.example.test/path', 'https://user@cloud.example.test']) {
    assert.equal((await configuredOrigin(invalid)).CLOUD_AVAILABLE, false)
  }
})
