import * as React from 'react'
import { MessageSquare } from 'lucide-react'
import { toast } from 'sonner'
import { analytics } from '@/lib/analytics'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { SidebarMenuButton } from '@/components/ui/sidebar'
import { Textarea } from '@/components/ui/textarea'

const UsageContext = React.createContext(null)
export const useUsageState = () => React.useSyncExternalStore(analytics.subscribe, analytics.getSnapshot)

export function UsageProvider({ children }) {
  const state = useUsageState()
  const [dialog, setDialog] = React.useState(null)
  const prompted = React.useRef(false)
  React.useEffect(() => {
    const firstRun = dialog === 'usage' || dialog === 'usage-details'
    if (firstRun && (!state.available || state.sharing !== null)) {
      setDialog(null)
    } else if (state.available && state.sharing === null && !dialog && !prompted.current && !window.location.hash.startsWith('#terminal/')) {
      prompted.current = true
      setDialog('usage')
    }
  }, [state.available, state.sharing, dialog])
  React.useEffect(() => {
    const changed = () => analytics.refresh()
    window.addEventListener('storage', changed)
    window.addEventListener('focus', changed)
    return () => { window.removeEventListener('storage', changed); window.removeEventListener('focus', changed) }
  }, [])
  const open = React.useCallback((next = 'settings') => setDialog(next), [])
  function chooseSharing(value) {
    analytics.setSharing(value)
    setDialog(null)
  }
  function close() {
    if (dialog === 'usage-details') setDialog('usage')
    else if (dialog === 'usage') chooseSharing(false)
    else setDialog(null)
  }
  const details = dialog === 'details' || dialog === 'usage-details'
  return <UsageContext.Provider value={open}>
    {children}
    <Dialog open={Boolean(dialog)} onOpenChange={value => { if (!value) close() }}>
      <DialogContent className={details ? 'flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg' : 'sm:max-w-sm'}>
        {dialog === 'usage' ? <>
          <DialogHeader>
            <DialogTitle>Help improve OpenRod</DialogTitle>
            <DialogDescription>Share usage metrics with PostHog. Never commands, files or names.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => chooseSharing(false)}>No thanks</Button>
            <Button type="button" size="sm" className="bg-[var(--action)] text-[var(--action-foreground)] hover:bg-[var(--action)]/90" onClick={() => chooseSharing(true)}>Share usage</Button>
          </div>
          <Button type="button" size="sm" variant="ghost" className="justify-self-start text-muted-foreground" onClick={() => setDialog('usage-details')}>What is being shared?</Button>
        </> : dialog === 'settings' ? <>
          <DialogHeader>
            <DialogTitle>Usage and feedback</DialogTitle>
            <DialogDescription>Usage metrics help improve OpenRod. Never commands, files or names.</DialogDescription>
          </DialogHeader>
          <div className="flex items-center justify-between gap-3 text-xs" role="status">
            <span className="flex items-center gap-2"><span className="text-muted-foreground">Usage sharing</span>
              <Badge variant={state.available && state.sharing ? 'secondary' : 'outline'}>{state.available && state.sharing ? 'On' : 'Off'}</Badge></span>
            {state.available && (state.sharing
              ? <Button size="sm" variant="outline" onClick={() => chooseSharing(false)}>Turn off</Button>
              : <Button size="sm" className="bg-[var(--action)] text-[var(--action-foreground)] hover:bg-[var(--action)]/90" onClick={() => chooseSharing(true)}>Share usage</Button>)}
          </div>
          {!state.available && <p className="text-xs text-muted-foreground">Usage sharing and feedback are turned off for this console.</p>}
          <div className="flex flex-wrap gap-2 border-t pt-3">
            <Button size="sm" variant="outline" onClick={() => setDialog('feedback')}>Give feedback</Button>
            <Button size="sm" variant="ghost" onClick={() => open('details')}>What is being shared?</Button>
          </div>
        </> : details ? <UsageDetails destination={state.destination} onClose={close} /> : dialog === 'feedback' ? <FeedbackForm canSend={state.available} onClose={() => setDialog(null)} /> : null}
      </DialogContent>
    </Dialog>
  </UsageContext.Provider>
}

export function UsageButton() {
  const open = React.useContext(UsageContext)
  if (!open) return null
  return <SidebarMenuButton size="sm" className="text-muted-foreground" onClick={() => open()}><MessageSquare aria-hidden="true" />Usage &amp; feedback</SidebarMenuButton>
}

function UsageDetails({ destination, onClose }) {
  const row = (title, text) => <div><dt className="text-[10px] font-medium text-muted-foreground">{title}</dt><dd>{text}</dd></div>
  return <>
    <DialogHeader className="shrink-0 border-b border-border px-5 py-4 pr-12">
      <DialogTitle>What is being shared?</DialogTitle>
      <DialogDescription className="text-xs">Nothing is sent until you choose to share.</DialogDescription>
    </DialogHeader>
    <dl className="min-h-0 divide-y divide-border overflow-y-auto px-5 text-xs leading-relaxed [&>div]:py-3 [&_dd]:mt-1">
      {row('Shared', 'Which screens and features you use, whether connecting, creating sandboxes and opening sessions work, and the OpenRod version. Events carry a random ID, not your name or account.')}
      {row('Never shared', 'Commands, terminal output, files, sandbox, host or template names, paths, credentials and error messages.')}
      {row('Feedback', 'Only the text you send. You can send feedback with sharing off; leave out private details.')}
      {row('Where it goes', `PostHog (${destination}). PostHog sees your IP address when it receives events; OpenRod turns off location lookup and person profiles.`)}
      {row('Turning it off', <>Turn sharing off in Usage &amp; feedback at any time. Start OpenRod with <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground">OPENROD_TELEMETRY=0</code> to turn off usage and feedback entirely.</>)}
    </dl>
    <DialogFooter className="mx-0 mb-0 shrink-0 rounded-none px-5 py-3">
      <Button type="button" size="sm" variant="outline" onClick={onClose}>Done</Button>
    </DialogFooter>
  </>
}

function FeedbackForm({ canSend, onClose }) {
  const [comment, setComment] = React.useState('')
  const [failed, setFailed] = React.useState(false)
  const prefix = React.useId()
  const copy = () => { try { void navigator.clipboard.writeText(comment).then(() => toast.success('Copied'), () => {}) } catch { /* optional */ } }
  function submit(event) {
    event.preventDefault()
    if (!analytics.submitFeedback({ prompt: 'general', category: 'general', text: comment })) { setFailed(true); return }
    toast.success('Thanks for the feedback')
    onClose()
  }
  return <form onSubmit={submit} className="grid gap-4">
    <DialogHeader><DialogTitle>Give feedback</DialogTitle><DialogDescription>Sent to the OpenRod team through PostHog. Leave out private details.</DialogDescription></DialogHeader>
    <div className="grid gap-1.5"><Label htmlFor={`${prefix}-text`}>Feedback</Label><Textarea id={`${prefix}-text`} value={comment} onChange={event => { setComment(event.target.value); setFailed(false) }} maxLength={2000} rows={4} /></div>
    {!canSend ? <p className="text-xs text-muted-foreground">Feedback is turned off for this console. Copy your text to share it another way.</p>
      : failed && <p role="alert" className="text-xs text-destructive">Couldn’t send it right now. Copy your text, or try again.</p>}
    <div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button><Button type="button" variant="outline" size="sm" disabled={!comment.trim()} onClick={copy}>Copy text</Button><Button type="submit" size="sm" disabled={!canSend || !comment.trim()} className="bg-[var(--action)] text-[var(--action-foreground)] hover:bg-[var(--action)]/90">Send feedback</Button></div>
  </form>
}
