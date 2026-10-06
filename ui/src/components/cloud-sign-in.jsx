export function CloudSignIn({ localConnect = false, error, busy, available, onLogin }) {
  return <main className="grid min-h-svh grid-cols-1 place-items-center bg-background px-4 py-6 sm:px-6 sm:py-10">
    <section aria-labelledby="cloud-sign-in-title" className="min-w-0 w-full max-w-sm rounded-xl border border-border bg-card px-5 py-7 text-center shadow-sm sm:px-8 sm:py-9">
      <img src="/openrod.png" alt="" width="96" height="96" className="mx-auto mb-6 size-24 object-contain" />
      <h1 id="cloud-sign-in-title" className="text-2xl font-semibold tracking-tight">OpenRod Cloud</h1>
      {localConnect && <p className="mt-2 text-sm text-muted-foreground">Sign in to connect this computer.</p>}
      <button type="button" disabled={!available || busy} aria-busy={busy || undefined} onClick={onLogin} className="mt-7 inline-flex h-10 w-full items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground outline-none transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50">{busy ? 'Signing in…' : 'Continue with Google'}</button>
      {error && <p role="alert" className="mt-4 text-xs leading-relaxed text-destructive">{error}</p>}
    </section>
  </main>
}
