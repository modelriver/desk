import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { confirmPortalCode, replyAsCustomer, requestPortalCode, signOutCustomer, type openCustomerTicket } from '../functions/customer-portal.ts'
import { Button, Input, Notice, Textarea } from './ui.tsx'
import { OtpInput } from './OtpInput.tsx'
import { BusyIcon } from './BusyIcon.tsx'
import { HelpBot } from './HelpBot.tsx'
import { LinkedText } from './LinkedText.tsx'
import { RelativeTime } from './RelativeTime.tsx'
import { SuccessTick } from './SuccessTick.tsx'
import { TicketIcon } from './icons.tsx'
import { cn } from '../lib/cn.ts'
import { errorMessage } from '../lib/errors.ts'
import { initials } from '../lib/initials.ts'
import { TICKET_LIMITS, type TicketStatus } from '../lib/ticket-core.ts'

// The customer portal's shared pieces: the page frame, signing in with an
// email code, a ticket's conversation with a reply box, and statuses in the
// customer's words.

export const PORTAL_STATUS: Record<TicketStatus, { label: string; tone: string }> = {
  open: { label: 'We’re on it', tone: 'bg-primary/10 text-primary' },
  pending: { label: 'Waiting for your reply', tone: 'bg-muted text-muted-foreground' },
  solved: { label: 'Solved', tone: 'bg-success/12 text-success' },
}

export function PortalShell({ children, signedInAs, onSignedOut }: { children: ReactNode; signedInAs?: string | null; onSignedOut?: () => void }) {
  const signOut = useServerFn(signOutCustomer)
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-10 sm:px-6 sm:py-14">
      {children}
      {signedInAs && (
        <p className="mt-8 text-center text-xs text-muted-foreground">
          Signed in as {signedInAs}.{' '}
          <button type="button" className="underline-offset-2 hover:text-foreground hover:underline" onClick={() => void signOut().then(() => onSignedOut?.())}>
            Sign out
          </button>
          {' · '}
          <Link to="/articles" className="underline-offset-2 hover:text-foreground hover:underline">
            Help articles
          </Link>
        </p>
      )}
    </div>
  )
}

// Email, then the 6-digit code; a tick for a moment, then `onSignedIn`.
export function PortalSignIn({ title, intro, canEmail, onSignedIn }: { title: string; intro: string; canEmail: boolean; onSignedIn: () => void }) {
  const requestCode = useServerFn(requestPortalCode)
  const confirm = useServerFn(confirmPortalCode)
  const [email, setEmail] = useState('')
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const onSignedInRef = useRef(onSignedIn)
  onSignedInRef.current = onSignedIn

  useEffect(() => {
    if (!done) return
    const timer = setTimeout(() => onSignedInRef.current(), 800)
    return () => clearTimeout(timer)
  }, [done])

  const run = async (fn: () => Promise<void>, fallback: string) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError(errorMessage(err, fallback))
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <div className="rounded-2xl border border-border bg-card px-6 py-10 text-center" role="status">
        <SuccessTick size={52} className="mx-auto" />
        <p className="mt-4 font-medium">You’re signed in</p>
      </div>
    )
  }

  return (
    <div className="rounded-2xl border border-border bg-card p-6 sm:p-8">
      <span className="grid size-10 place-items-center rounded-full bg-muted text-muted-foreground" aria-hidden="true">
        <TicketIcon size={18} />
      </span>
      <h1 className="mt-4 font-serif text-2xl leading-tight">{title}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{sentTo ? `We’ve sent a 6-digit code to ${sentTo}. Enter it below.` : intro}</p>
      {!canEmail ? (
        <p className="mt-5 rounded-lg bg-muted/60 px-3 py-2.5 text-sm text-muted-foreground">
          Signing in isn’t available right now. Open your ticket from the link in our email instead.
        </p>
      ) : sentTo ? (
        <div className="mt-5 grid gap-3">
          <OtpInput
            key={attempt}
            label="Code from the email"
            autoFocus
            disabled={busy}
            invalid={!!error}
            onComplete={(code) =>
              void run(async () => {
                try {
                  await confirm({ data: { email, code } })
                  setDone(true)
                } catch (err) {
                  setAttempt((a) => a + 1)
                  throw err
                }
              }, 'Couldn’t check the code.')
            }
          />
          {error && (
            <p role="alert" className="text-center text-sm text-destructive">
              {error}
            </p>
          )}
          {busy ? (
            <p className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground" aria-live="polite">
              <BusyIcon busy size={12} />
              Checking…
            </p>
          ) : (
            <button
              type="button"
              className="justify-self-center text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              onClick={() => {
                setSentTo(null)
                setError(null)
              }}
            >
              Use a different email or send a new code
            </button>
          )}
        </div>
      ) : (
        <>
          <form
            className="mt-5 grid gap-3 sm:flex"
            onSubmit={(e) => {
              e.preventDefault()
              if (email.trim()) void run(async () => setSentTo((await requestCode({ data: { email } })).sentTo), 'Couldn’t send the code.')
            }}
          >
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              autoFocus
              required
              placeholder="you@example.com"
              aria-label="Your email"
              maxLength={254}
              className="h-9"
            />
            <Button type="submit" size="lg" disabled={busy || !email.trim()} className="shrink-0">
              <BusyIcon busy={busy} size={14} />
              Send code
            </Button>
          </form>
          {error && (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {error}
            </p>
          )}
        </>
      )}
    </div>
  )
}

type TicketData = Extract<Awaited<ReturnType<typeof openCustomerTicket>>, { state: 'ticket' }>

// One ticket: the conversation so far, and the customer's reply box.
export function CustomerTicketView({ data, onChange }: { data: TicketData; onChange: (next: TicketData) => void }) {
  const { ticket } = data
  const reply = useServerFn(replyAsCustomer)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  const status = PORTAL_STATUS[ticket.status]

  const send = async () => {
    setBusy(true)
    setError(null)
    try {
      onChange(await reply({ data: { ref: ticket.ref, text } }))
      setText('')
      setSent(true)
    } catch (err) {
      setError(errorMessage(err, 'Couldn’t send your reply. Please try again.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Link to="/customer-portal" className="text-sm text-muted-foreground hover:text-foreground">
        ← Your tickets
      </Link>
      <div className="mt-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-xs text-muted-foreground">#{ticket.ref}</p>
          <h1 className="mt-1 font-serif text-2xl leading-tight [overflow-wrap:anywhere] sm:text-3xl">{ticket.subject}</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Raised <RelativeTime iso={ticket.createdAt} />
          </p>
        </div>
        <span className={cn('rounded-full px-2.5 py-1 text-xs font-medium whitespace-nowrap', status.tone)}>{status.label}</span>
      </div>

      <ol className="mt-8 grid gap-4">
        {ticket.thread.map((m) => (
          <li key={m.id} className="flex gap-3">
            {m.avatar ? (
              <img src={m.avatar} alt="" className="size-8 shrink-0 rounded-full object-cover" />
            ) : m.from === 'team' ? (
              <span className="grid size-8 shrink-0 place-items-center">
                <HelpBot size={30} animated={false} />
              </span>
            ) : (
              <span className="grid size-8 shrink-0 place-items-center rounded-full bg-muted text-[11px] font-semibold text-muted-foreground" aria-hidden="true">
                {initials(m.name)}
              </span>
            )}
            <div className={cn('min-w-0 flex-1 rounded-xl border px-4 py-3', m.from === 'team' ? 'border-border bg-card' : 'border-transparent bg-muted/60')}>
              <p className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{m.from === 'team' ? `${m.name}, from our team` : 'You'}</span>
                {' · '}
                <RelativeTime iso={m.at} />
              </p>
              <p className="mt-1.5 text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">
                <LinkedText text={m.body} />
              </p>
            </div>
          </li>
        ))}
      </ol>

      <form
        className="mt-6 rounded-xl border border-border bg-card p-4"
        onSubmit={(e) => {
          e.preventDefault()
          if (text.trim()) void send()
        }}
      >
        <label htmlFor="customer-reply" className="text-sm font-medium">
          Reply
        </label>
        <Textarea
          id="customer-reply"
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            setSent(false)
          }}
          maxLength={TICKET_LIMITS.message}
          placeholder="Add details, or answer our questions…"
          className="mt-2 min-h-28 resize-y"
        />
        {error && (
          <div className="mt-3">
            <Notice tone="error">{error}</Notice>
          </div>
        )}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {sent ? 'Sent. Our team will get back to you by email.' : ticket.status === 'solved' ? 'Replying opens this ticket again.' : 'We’ll email you when we reply.'}
          </p>
          <Button type="submit" disabled={busy || !text.trim()}>
            <BusyIcon busy={busy} size={14} />
            Send reply
          </Button>
        </div>
      </form>
    </>
  )
}
