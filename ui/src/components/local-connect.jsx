import * as React from 'react'
import { CloudAgents } from '@/components/cloud-agents'
import { authorizeLocalConnection, localConnectFromHash } from '@/lib/local-cloud'

export function LocalConnect({ children, user, logout }) {
  const [handoff] = React.useState(() => window.location.hash.startsWith('#local-connect=') ? localConnectFromHash(window.location.hash) ?? false : null)
  const [error, setError] = React.useState('')
  const authorization = React.useRef(null)
  const valid = handoff && window.opener && !window.opener.closed
  React.useEffect(() => {
    if (!valid) return
    let active = true
    // StrictMode can replay the effect; share the single authorization request.
    authorization.current ??= authorizeLocalConnection(handoff)
    const timer = setTimeout(() => { if (active) setError('Could not reach local OpenRod. Close this window and try again.') }, 30_000)
    authorization.current.then(({ code }) => {
      if (!active) return
      window.opener.postMessage({ type: 'openrod-local-connected', nonce: handoff.nonce, code }, handoff.origin)
    }).catch(e => { clearTimeout(timer); if (active) setError(e.message) })
    return () => { active = false; clearTimeout(timer) }
  }, [handoff, valid])
  if (handoff === null) return children
  return <main className="grid min-h-screen place-items-center px-6"><section className="max-w-sm text-center">
    {valid && !error && <CloudAgents />}
    <h1 className="text-2xl font-semibold">{error || !valid ? 'Sign-in interrupted' : 'Finishing sign-in…'}</h1>
    <p className="mt-3 text-sm text-muted-foreground">{valid && !error ? <>Signed in as {user.email}.<br />High demand may slow this down.</> : 'Start again from local OpenRod.'}</p>
    {error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}
    {(error || !valid) && <button className="mt-5 block w-full text-xs underline" onClick={logout}>Sign out</button>}
  </section></main>
}
