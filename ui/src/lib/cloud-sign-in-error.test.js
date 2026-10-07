import test from 'node:test'
import assert from 'node:assert/strict'
import { cloudSignInError } from './cloud-sign-in-error.js'

test('sign-in errors give a recovery action without exposing SDK details', () => {
  assert.match(cloudSignInError({ code: 'auth/network-request-failed' }), /Check your connection/)
  assert.match(cloudSignInError({ code: 'auth/popup-blocked' }), /Allow popups/)
  assert.equal(cloudSignInError({ code: 'auth/popup-closed-by-user' }), 'Sign-in cancelled.')
  assert.equal(cloudSignInError({ message: 'Firebase: internal credentials diagnostic' }), 'Couldn’t sign in. Try again.')
})
