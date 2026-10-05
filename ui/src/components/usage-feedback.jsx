import * as React from 'react'
import { MessageSquare } from 'lucide-react'
import { analytics } from '@/lib/analytics'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

const UsageContext = React.createContext(null)
export const useUsageState = () => React.useSyncExternalStore(analytics.subscribe, analytics.getSnapshot)
const terminalTab = () => window.location.hash.startsWith('#terminal/')

export function UsageProvider({ children }) {
  const state = useUsageState()
  const [dialog, setDialog] = React.useState(null)
  const prompted = React.useRef(false)
  React.useEffect(() => {
    const changed = () => analytics.refresh()
    window.addEventListener('storage', changed)
    window.addEventListener('focus', changed)
    return () => { window.removeEventListener('storage', changed); window.removeEventListener('focus', changed) }
  }, [])
  React.useEffect(() => {
    if (!state.available || state.sharing !== null || dialog || terminalTab() || prompted.current) return
    prompted.current = true
    setDialog('usage')
  }, [state.available, state.sharing, dialog])
  const open = React.useCallback(() => setDialog('settings'), [])
  function close() {
    if (dialog === 'usage') analytics.setSharing(false)
    setDialog(null)
  }
  function chooseSharing(value) {
    analytics.setSharing(value)
    setDialog(null)
  }
  return <UsageContext.Provider value={open}>
    {children}
    <Dialog open={Boolean(dialog)} onOpenChange={value => { if (!value) close() }}>
      <DialogContent showCloseButton={dialog !== 'usage'} className="sm:max-w-sm">
        {dialog === 'usage' || dialog === 'settings' ? <>
          <DialogHeader>
            <DialogTitle>{dialog === 'usage' ? 'Help improve OpenRod' : 'Usage and feedback'}</DialogTitle>
            <DialogDescription>Share anonymous usage metrics with PostHog ({state.destination}) to improve OpenRod. No commands or project content.</DialogDescription>
          </DialogHeader>
          {dialog === 'settings' && <p className="text-xs font-medium" role="status">Usage sharing: {state.available && state.sharing ? 'On' : 'Off'}</p>}
          {state.available ? <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => chooseSharing(false)}>{dialog === 'usage' ? 'No thanks' : 'Turn sharing off'}</Button>
            <Button size="sm" onClick={() => chooseSharing(true)}>{dialog === 'usage' ? 'Approve' : 'Share usage'}</Button>
          </div> : <p className="text-xs text-muted-foreground">Usage sharing is disabled for this console.</p>}
          {dialog === 'settings' && <div className="border-t pt-3">
            <Button size="sm" variant="outline" onClick={() => setDialog('feedback')}>Give feedback</Button>
          </div>}
        </> : dialog === 'feedback' ? <FeedbackForm canSend={state.available} onClose={() => setDialog(null)} /> : null}
      </DialogContent>
    </Dialog>
  </UsageContext.Provider>
}

export function UsageButton() {
  const open = React.useContext(UsageContext)
  if (!open) return null
  return <Button variant="ghost" size="sm" className="justify-start text-xs" onClick={open}><MessageSquare className="size-3.5" aria-hidden="true" />Usage &amp; feedback</Button>
}

function FeedbackForm({ canSend, onClose }) {
  const [comment, setComment] = React.useState('')
  const prefix = React.useId()
  const copy = () => { try { void navigator.clipboard.writeText(comment).catch(() => {}) } catch { /* optional */ } }
  function submit(event) {
    event.preventDefault()
    analytics.submitFeedback({ prompt: 'general', category: 'general', text: comment })
    onClose()
  }
  return <form onSubmit={submit} className="grid gap-4">
    <DialogHeader><DialogTitle>Give feedback</DialogTitle><DialogDescription>Feedback goes to PostHog. Please omit private details.</DialogDescription></DialogHeader>
    <div className="grid gap-1.5"><Label htmlFor={`${prefix}-text`}>Feedback</Label><Textarea id={`${prefix}-text`} value={comment} onChange={event => setComment(event.target.value)} maxLength={2000} rows={4} /></div>
    <div className="flex justify-end gap-2"><Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button><Button type="button" variant="outline" size="sm" disabled={!comment.trim()} onClick={copy}>Copy text</Button><Button type="submit" size="sm" disabled={!canSend || !comment.trim()}>Send feedback</Button></div>
  </form>
}
