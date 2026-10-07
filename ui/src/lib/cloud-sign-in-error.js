const messages = {
  'auth/network-request-failed': 'Couldn’t reach Google. Check your connection and try again.',
  'auth/popup-closed-by-user': 'Sign-in cancelled.',
  'auth/cancelled-popup-request': 'Sign-in cancelled.',
  'auth/popup-blocked': 'Allow popups, then try again.',
  'auth/unauthorized-domain': 'Sign-in isn’t configured for this address. Contact your administrator.',
  'auth/user-disabled': 'This account is disabled. Contact your administrator.',
  'auth/too-many-requests': 'Too many attempts. Try again shortly.',
}

export function cloudSignInError(reason) {
  return messages[reason?.code] || 'Couldn’t sign in. Try again.'
}
