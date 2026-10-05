import * as React from 'react'
import { MessageSquare } from 'lucide-react'
import { analytics, INTENTS } from '@/lib/analytics'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { SelectField } from '@/components/ui/select-field'
import { Textarea } from '@/components/ui/textarea'

const UsageContext = React.createContext(null)
export const useUsageState = () => React.useSyncExternalStore(analytics.subscribe, analytics.getSnapshot)
const terminalTab = () => window.location.hash.startsWith('#terminal/')

export function UsageProvider({ children }) {
  const state = useUsageState()
  const [dialog, setDialog] = React.useState(null)
  const prompted = React.useRef(new Set())
  React.useEffect(() => {
    const changed = () => analytics.refresh()
    window.addEventListener('storage', changed)
    window.addEventListener('focus', changed)
    return () => { window.removeEventListener('storage', changed); window.removeEventListener('focus', changed) }
  }, [])
  React.useEffect(() => {
    if (!state.available || dialog || terminalTab()) return
    if (state.sharing === null && !prompted.current.has('usage')) {
      prompted.current.add('usage'); setDialog({ prompt: 'usage' })
    } else if (state.sharing === true && analytics.promptEligible('intent') && !prompted.current.has('intent')) {
      prompted.current.add('intent'); analytics.promptInteraction('intent', 'shown'); setDialog({ prompt: 'intent' })
    }
  }, [state.available, state.sharing, dialog])
  React.useEffect(() => {
    const candidate = state.candidate
    if (!state.available || !state.sharing || !candidate || dialog || terminalTab()) return
    let timer
    const show = () => {
      if (document.visibilityState !== 'visible' || !analytics.promptEligible(candidate.prompt) || prompted.current.has(candidate.flow_id)) return
      const delay = candidate.prompt === 'outcome' ? Math.max(0, candidate.at + 60000 - Date.now()) : 0
      clearTimeout(timer)
      timer = setTimeout(() => {
        if (document.visibilityState !== 'visible' || !analytics.promptEligible(candidate.prompt) || prompted.current.has(candidate.flow_id)) return
        prompted.current.add(candidate.flow_id)
        analytics.promptInteraction(candidate.prompt, 'shown', candidate.flow_id)
        setDialog(candidate)
      }, delay)
    }
    show(); document.addEventListener('visibilitychange', show)
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', show) }
  }, [state.available, state.sharing, state.candidate, dialog])
  const open = React.useCallback(() => setDialog({ prompt: 'settings' }), [])
  function close() {
    if (dialog?.prompt === 'usage') analytics.setSharing(false)
    else if (['intent', 'outcome', 'blocker', 'general'].includes(dialog?.prompt)) analytics.promptInteraction(dialog.prompt, 'dismissed', dialog.flow_id)
    setDialog(null)
  }
  return <UsageContext.Provider value={open}>
    {children}
    <Dialog open={Boolean(dialog)} onOpenChange={value => { if (!value) close() }}>
      <DialogContent className="sm:max-w-md">
        {dialog?.prompt === 'usage' || dialog?.prompt === 'settings' ? <>
          <DialogHeader>
            <DialogTitle>{dialog.prompt === 'usage' ? 'Help improve OpenRod' : 'Usage and feedback'}</DialogTitle>
            <DialogDescription>Share anonymous usage to help us understand what works and where people get stuck. Sharing is optional.</DialogDescription>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">We send feature choices, connection and sandbox outcomes to PostHog in the {state.destination}. Commands, terminal output, credentials, project paths and host names stay on your machine. If delivery is blocked, OpenRod keeps working.</p>
          {dialog.prompt === 'settings' && <p className="text-xs font-medium" role="status">Usage sharing: {state.available && state.sharing ? 'On' : 'Off'}</p>}
          {state.available ? <div className="flex flex-wrap gap-2">
            <Button size="sm" variant={state.sharing ? 'default' : 'outline'} onClick={() => { analytics.setSharing(true); setDialog(null) }}>Share anonymous usage</Button>
            <Button size="sm" variant={state.sharing === false ? 'default' : 'outline'} onClick={() => { analytics.setSharing(false); setDialog(null) }}>{dialog.prompt === 'usage' ? 'No thanks' : 'Turn sharing off'}</Button>
          </div> : <p className="text-xs text-muted-foreground">Usage sharing is disabled for this console.</p>}
          {dialog.prompt === 'settings' && <div className="flex gap-2 border-t pt-3">
            <Button size="sm" variant="outline" onClick={() => { analytics.promptInteraction('general', 'shown'); setDialog({ prompt: 'general' }) }}>Give feedback</Button>
            {state.sharing && <Button size="sm" variant="ghost" onClick={() => { analytics.promptInteraction('intent', 'shown'); setDialog({ prompt: 'intent' }) }}>Change my goal</Button>}
          </div>}
        </> : dialog ? <FeedbackForm key={`${dialog.prompt}:${dialog.flow_id ?? ''}`} context={dialog} canSend={state.available}
          onClose={() => setDialog(null)} onSkip={close} /> : null}
      </DialogContent>
    </Dialog>
  </UsageContext.Provider>
}

export function UsageButton() {
  const open = React.useContext(UsageContext)
  if (!open) return null
  return <Button variant="ghost" size="sm" className="justify-start text-xs" onClick={open}><MessageSquare className="size-3.5" aria-hidden="true" />Usage &amp; feedback</Button>
}

function FeedbackForm({ context, canSend, onClose, onSkip }) {
  const [goal, setGoal] = React.useState('project')
  const [outcome, setOutcome] = React.useState('yes')
  const [category, setCategory] = React.useState(context.prompt === 'blocker' ? 'setup' : 'general')
  const [comment, setComment] = React.useState('')
  const prefix = React.useId()
  const askingIntent = context.prompt === 'intent'
  const title = askingIntent ? 'What brought you to OpenRod?' : context.prompt === 'outcome' ? 'Did you get to do what you came for?' : context.prompt === 'blocker' ? 'What stopped you?' : 'Give feedback'
  const copy = () => { try { void navigator.clipboard.writeText(comment).catch(() => {}) } catch { /* optional */ } }
  function submit(event) {
    event.preventDefault()
    if (askingIntent) analytics.setIntent(goal)
    if (!askingIntent || comment.trim()) analytics.submitFeedback({ prompt: context.prompt, category: askingIntent ? 'other' : category,
      ...(context.prompt === 'outcome' ? { goal_achieved: outcome } : {}), text: comment, flow_id: context.flow_id })
    onClose()
  }
  return <form onSubmit={submit} className="grid gap-4">
    <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{askingIntent ? 'Optional. This helps us prioritize the work you need.' : 'Optional feedback goes to PostHog. Please omit secrets and private project details.'}</DialogDescription></DialogHeader>
    {askingIntent ? <div className="grid gap-1.5"><Label htmlFor={`${prefix}-goal`}>Your goal</Label><SelectField id={`${prefix}-goal`} value={goal} onChange={event => setGoal(event.target.value)}>{Object.entries(INTENTS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</SelectField></div>
      : context.prompt === 'outcome' ? <div className="grid gap-1.5"><Label htmlFor={`${prefix}-outcome`}>Goal achieved</Label><SelectField id={`${prefix}-outcome`} value={outcome} onChange={event => setOutcome(event.target.value)}><option value="yes">Yes</option><option value="partly">Partly</option><option value="no">No</option></SelectField></div>
      : <div className="grid gap-1.5"><Label htmlFor={`${prefix}-category`}>Category</Label><SelectField id={`${prefix}-category`} value={category} onChange={event => setCategory(event.target.value)}>{[['general', 'General feedback'], ['setup', 'Setup'], ['connection', 'Connection'], ['missing_capability', 'Missing capability'], ['instructions', 'Unclear instructions'], ['other', 'Other']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</SelectField></div>}
    <div className="grid gap-1.5"><Label htmlFor={`${prefix}-text`}>{askingIntent ? 'Anything else?' : 'What was missing or could be better?'} <span className="text-muted-foreground">(optional)</span></Label><Textarea id={`${prefix}-text`} value={comment} onChange={event => setComment(event.target.value)} maxLength={2000} rows={4} /></div>
    <p className="text-xs text-muted-foreground">You can copy your text to keep it.</p>
    <div className="flex justify-end gap-2"><Button type="button" variant="ghost" size="sm" onClick={onSkip}>Skip</Button><Button type="button" variant="outline" size="sm" disabled={!comment.trim()} onClick={copy}>Copy text</Button><Button type="submit" size="sm" disabled={!canSend}>{askingIntent ? 'Save goal' : 'Send this feedback'}</Button></div>
  </form>
}
