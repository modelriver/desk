import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createFileRoute, Link, useNavigate, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import {
  addTicketNote,
  assignTicketTo,
  blockCustomerEmail,
  unblockCustomerEmail,
  changeTicketStatus,
  draftTicketReply,
  getTicketPage,
  removeTicket,
  replyToTicket,
  resendTicketReply,
} from '../../functions/tickets.ts'
import { LoadError } from '../../components/LoadError.tsx'
import { ArrowLeftIcon, ChevronRightIcon, MailIcon, ShieldIcon, SparklesIcon, TrashIcon } from '../../components/icons.tsx'
import { Badge, Button, Notice, PageHeader, Select, Textarea } from '../../components/ui.tsx'
import { Segmented } from '../../components/Segmented.tsx'
import { RelativeTime } from '../../components/RelativeTime.tsx'
import { BusyIcon } from '../../components/BusyIcon.tsx'
import { HelpBot } from '../../components/HelpBot.tsx'
import { LinkedText } from '../../components/LinkedText.tsx'
import { ConfirmDialog } from '../../components/DataDialogs.tsx'
import { cn } from '../../lib/cn.ts'
import { errorMessage } from '../../lib/errors.ts'
import { initials } from '../../lib/initials.ts'
import { STATUS_LABEL, TICKET_LIMITS, type TicketStatus } from '../../lib/ticket-core.ts'

export const Route = createFileRoute('/dashboard/tickets/$ticketRef')({
  head: () => ({ meta: [{ title: 'Ticket · Dashboard' }] }),
  loader: ({ params }) => getTicketPage({ data: { ref: params.ticketRef } }),
  errorComponent: ({ error }) => (
    <>
      <BackLink />
      <PageHeader title="Ticket" />
      <LoadError title="Couldn’t load this ticket" error={error} />
    </>
  ),
  component: TicketPage,
})

type Data = Awaited<ReturnType<typeof getTicketPage>>
type Event = Data['ticket']['events'][number]

function BackLink() {
  return (
    <Link to="/dashboard/tickets" className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
      <ArrowLeftIcon size={14} />
      Tickets
    </Link>
  )
}

function TicketPage() {
  const data = Route.useLoaderData()
  const { ticket, team } = data
  const router = useRouter()
  const navigate = useNavigate()
  const setStatus = useServerFn(changeTicketStatus)
  const assign = useServerFn(assignTicketTo)
  const remove = useServerFn(removeTicket)
  const resend = useServerFn(resendTicketReply)
  const block = useServerFn(blockCustomerEmail)
  const unblock = useServerFn(unblockCustomerEmail)
  const [blocking, setBlocking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      await router.invalidate()
      return true
    } catch (err) {
      setError(errorMessage(err, 'Something went wrong. Try again.'))
      await router.invalidate()
      return false
    } finally {
      setBusy(false)
    }
  }

  const avatarOf = (id: string | null) => team.find((u) => u.id === id)?.avatar ?? null

  return (
    <>
      <BackLink />
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-xs text-muted-foreground">#{ticket.ref}</p>
          <h1 className="mt-0.5 text-xl font-semibold tracking-tight [overflow-wrap:anywhere]">{ticket.subject}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {ticket.source === 'team'
              ? `Opened by ${ticket.createdBy ?? 'the team'}`
              : ticket.source === 'portal'
                ? 'Raised in the customer portal'
                : 'Raised in the chat'}{' '}
            <RelativeTime iso={ticket.createdAt} />
          </p>
        </div>
        <Badge variant={ticket.status === 'open' ? 'priority' : ticket.status === 'solved' ? 'success' : 'muted'}>{STATUS_LABEL[ticket.status]}</Badge>
      </div>

      {error && (
        <div className="mb-4">
          <Notice tone="error">{error}</Notice>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_17rem]">
        <div className="min-w-0">
          <ol className="grid gap-4">
            {ticket.events.map((e) => (
              <li key={e.id}>
                <EventRow
                  event={e}
                  customer={ticket.visitorName}
                  avatar={avatarOf(e.authorId)}
                  retrying={data.retrying.includes(e.id)}
                  busy={busy}
                  onResend={() => void run(() => resend({ data: { eventId: e.id, then: 'pending' } }))}
                />
              </li>
            ))}
          </ol>
          <Composer data={data} onDone={() => router.invalidate()} />
        </div>

        <aside className="grid content-start gap-4">
          <Panel title="Status">
            <Select
              value={ticket.status}
              disabled={busy}
              aria-label="Status"
              onChange={(e) => void run(() => setStatus({ data: { id: ticket.id, status: e.target.value as TicketStatus } }))}
            >
              {(Object.keys(STATUS_LABEL) as TicketStatus[]).map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </Select>
          </Panel>
          <Panel title="Assigned to">
            <Select
              value={ticket.assignee?.id ?? ''}
              disabled={busy}
              aria-label="Assigned to"
              onChange={(e) => void run(() => assign({ data: { id: ticket.id, assigneeId: e.target.value || null } }))}
            >
              <option value="">Nobody</option>
              {team.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.id === data.me.id ? `${u.name} (you)` : u.name}
                </option>
              ))}
            </Select>
            {ticket.assignee?.id !== data.me.id && (
              <button
                type="button"
                disabled={busy}
                className="mt-1.5 text-xs text-primary underline-offset-4 hover:underline"
                onClick={() => void run(() => assign({ data: { id: ticket.id, assigneeId: data.me.id } }))}
              >
                Assign to me
              </button>
            )}
          </Panel>
          <Panel title="Customer">
            <p className="text-sm font-medium">{ticket.visitorName}</p>
            {ticket.email ? (
              <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground [overflow-wrap:anywhere]">
                {ticket.email}
                {ticket.emailVerified && (
                  <Badge variant="success" title="Proved in the chat with an email code or a sign-in token">
                    <ShieldIcon size={11} />
                    Verified
                  </Badge>
                )}
              </p>
            ) : (
              <p className="mt-0.5 text-sm text-muted-foreground">No email address</p>
            )}
            {ticket.email &&
              (data.blocked ? (
                <p className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                  <Badge variant="danger">Blocked</Badge>
                  <button
                    type="button"
                    disabled={busy}
                    className="text-primary underline-offset-4 hover:underline"
                    onClick={() => void run(() => unblock({ data: { email: ticket.email! } }))}
                  >
                    Unblock
                  </button>
                </p>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  className="mt-2 block text-xs text-muted-foreground underline-offset-4 hover:text-destructive hover:underline"
                  onClick={() => setBlocking(true)}
                >
                  Block this customer
                </button>
              ))}
            {ticket.sessionId && (
              <Link
                to="/dashboard/c/$sessionId"
                params={{ sessionId: ticket.sessionId }}
                className="mt-2 inline-flex items-center gap-1 text-sm text-primary underline-offset-4 hover:underline"
              >
                Open the chat
                <ChevronRightIcon size={14} />
              </Link>
            )}
          </Panel>
          {data.me.role === 'admin' && (
            <Button variant="ghost-destructive" size="sm" className="justify-self-start" disabled={busy} onClick={() => setDeleting(true)}>
              <TrashIcon size={14} />
              Delete ticket
            </Button>
          )}
        </aside>
      </div>

      <ConfirmDialog
        open={blocking}
        title={`Block ${ticket.email}?`}
        confirmLabel="Block customer"
        busy={busy}
        onClose={() => setBlocking(false)}
        onConfirm={() => void run(() => block({ data: { email: ticket.email! } })).then(() => setBlocking(false))}
      >
        They can’t sign in to the customer portal, open links from our emails, raise tickets (in the portal or the chat) or reply, and
        they’re signed out now. They aren’t told. You can still email them, and unblock them any time under Tickets → Blocked customers.
      </ConfirmDialog>

      <ConfirmDialog
        open={deleting}
        title={`Delete ticket #${ticket.ref}?`}
        confirmLabel="Delete ticket"
        icon={<TrashIcon size={18} />}
        busy={busy}
        onClose={() => setDeleting(false)}
        onConfirm={() =>
          void run(() => remove({ data: { id: ticket.id } })).then((ok) => {
            setDeleting(false)
            if (ok) void navigate({ to: '/dashboard/tickets' })
          })
        }
      >
        Its messages, replies and notes are removed for good. The customer isn’t told, and emails already sent stay in their inbox.
      </ConfirmDialog>
    </>
  )
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <h2 className="mb-2 text-xs font-medium text-muted-foreground">{title}</h2>
      {children}
    </section>
  )
}

function Face({ name, avatar, customer }: { name: string; avatar?: string | null; customer?: boolean }) {
  if (avatar) return <img src={avatar} alt="" className="size-8 shrink-0 rounded-full object-cover" />
  return (
    <span
      className={cn(
        'grid size-8 shrink-0 place-items-center rounded-full text-[11px] font-semibold',
        customer ? 'bg-muted text-muted-foreground' : 'bg-primary/15 text-primary',
      )}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  )
}

// One thing that happened on the ticket. Status and assignee changes are a
// quiet line; messages, replies and notes are cards (notes dashed: the
// customer never sees them).
function EventRow({
  event: e,
  customer,
  avatar,
  retrying,
  busy,
  onResend,
}: {
  event: Event
  customer: string
  avatar: string | null
  // A failed reply Desk is still trying to send on its own.
  retrying: boolean
  busy: boolean
  onResend: () => void
}) {
  const name = e.authorName ?? 'Someone'
  if (e.kind === 'status' || e.kind === 'assign') {
    return (
      <p className="flex flex-wrap items-center gap-x-1.5 pl-11 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{name}</span>
        {e.kind === 'status' ? `set it to ${STATUS_LABEL[e.body as TicketStatus] ?? e.body}` : e.body ? `assigned it to ${e.body}` : 'unassigned it'}
        <span aria-hidden="true">·</span>
        <RelativeTime iso={e.createdAt} />
      </p>
    )
  }
  const note = e.kind === 'note'
  return (
    <div className="flex gap-3">
      <Face name={e.kind === 'message' ? customer : name} avatar={e.kind === 'message' ? null : avatar} customer={e.kind === 'message'} />
      <div
        className={cn(
          'min-w-0 flex-1 rounded-xl border px-4 py-3',
          note ? 'border-dashed border-border bg-muted/40' : 'border-border bg-card',
          e.emailStatus === 'failed' && 'border-destructive/40',
        )}
      >
        <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{e.kind === 'message' ? customer : name}</span>
          {e.kind === 'message' ? 'wrote' : e.kind === 'reply' ? (
            <span className="inline-flex items-center gap-1">
              replied by email
              <MailIcon size={12} />
            </span>
          ) : (
            'added an internal note'
          )}
          <span aria-hidden="true">·</span>
          <RelativeTime iso={e.createdAt} />
        </p>
        <p className="mt-1.5 text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">
          <LinkedText text={e.body} />
        </p>
        {e.emailStatus === 'failed' && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <span className="min-w-0">
              Not sent: {e.emailError ?? 'the email provider refused it'}.{retrying && ' Desk will try again on its own for a while.'}
            </span>
            <Button size="sm" variant="outline" disabled={busy} onClick={onResend}>
              Send again
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

// Reply (emailed to the customer) or internal note (team only), with an
// AI-drafted reply to start from.
const DRAFT_STEPS = ['Reading the ticket…', 'Looking through your help articles…', 'Writing a draft…']

function Composer({ data, onDone }: { data: Data; onDone: () => Promise<void> | void }) {
  const { ticket } = data
  const reply = useServerFn(replyToTicket)
  const note = useServerFn(addTicketNote)
  const draft = useServerFn(draftTicketReply)
  const canEmail = Boolean(ticket.email) && data.email.ready
  const [mode, setMode] = useState<'reply' | 'note'>(canEmail ? 'reply' : 'note')
  const [text, setText] = useState('')
  const [then, setThen] = useState<TicketStatus>('pending')
  const [busy, setBusy] = useState<'send' | 'draft' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [drafted, setDrafted] = useState(false)
  // The draft writing itself in (see typeIn), and the whole of it, for "Show all".
  const [typing, setTyping] = useState(false)
  const fullDraft = useRef('')
  const typer = useRef<ReturnType<typeof setInterval> | undefined>(undefined)
  const box = useRef<HTMLTextAreaElement>(null)
  useEffect(() => () => clearInterval(typer.current), [])

  // While the draft is written, the status moves through what the AI is doing.
  const [step, setStep] = useState(0)
  useEffect(() => {
    if (busy !== 'draft') return
    setStep(0)
    const timer = setInterval(() => setStep((n) => Math.min(n + 1, DRAFT_STEPS.length - 1)), 1400)
    return () => clearInterval(timer)
  }, [busy])

  // The draft types itself in a few words at a time, in about a second and a
  // half whatever its length, following along as it goes. Reduced motion: all at once.
  const typeIn = (full: string) => {
    fullDraft.current = full
    clearInterval(typer.current)
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return setText(full)
    const per = Math.max(3, Math.ceil(full.length / 90))
    let at = 0
    setTyping(true)
    setText('')
    typer.current = setInterval(() => {
      let next = Math.min(full.length, at + per)
      // End each step on a word rather than in the middle of one.
      const space = full.indexOf(' ', next)
      if (space !== -1 && space - next < 10) next = space + 1
      at = next
      setText(full.slice(0, at))
      if (at >= full.length) {
        clearInterval(typer.current)
        setTyping(false)
      }
    }, 16)
  }
  const showAll = () => {
    clearInterval(typer.current)
    setText(fullDraft.current)
    setTyping(false)
  }
  useEffect(() => {
    if (typing && box.current) box.current.scrollTop = box.current.scrollHeight
  }, [text, typing])

  const send = async () => {
    setBusy('send')
    setError(null)
    try {
      if (mode === 'reply') await reply({ data: { id: ticket.id, body: text, then } })
      else await note({ data: { id: ticket.id, body: text } })
      setText('')
      setDrafted(false)
    } catch (err) {
      setError(errorMessage(err, 'Couldn’t save it. Try again.'))
    } finally {
      setBusy(null)
      await onDone()
    }
  }

  const writeDraft = async () => {
    setBusy('draft')
    setError(null)
    try {
      const res = await draft({ data: { id: ticket.id } })
      setDrafted(true)
      typeIn(res.draft)
    } catch (err) {
      setError(errorMessage(err, 'Couldn’t write a draft. Try again.'))
    } finally {
      setBusy(null)
    }
  }

  const magic = busy === 'draft' || typing
  // An AI draft's placeholder still in the text: it would go to the customer as it is.
  const unfilled = mode === 'reply' && /\[add details\]/i.test(text)
  // Customers' replies would bounce or vanish: SUPPORT_REPLY_TO isn't set and the sender is a no-reply address.
  const noReply = /no-?reply/i.test(data.email.replyTo ?? '')

  const why = !ticket.email
    ? 'This ticket has no email address, so there’s no one to reply to by email. Add a note, or reply in the chat while they’re there.'
    : !data.email.ready
      ? 'Email isn’t set up on this server, so replies can’t be sent. Set EMAIL_PROVIDER and restart; notes still work.'
      : null

  return (
    <div className="mt-6 rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <Segmented
          label="Reply or note"
          size="sm"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'reply', label: 'Reply to customer' },
            { value: 'note', label: 'Internal note' },
          ]}
        />
        {mode === 'reply' && canEmail && data.canDraft && (
          <Button variant="outline" size="sm" disabled={busy !== null || typing} onClick={() => void writeDraft()}>
            {busy === 'draft' ? <HelpBot mood="thinking" size={16} /> : <SparklesIcon size={14} />}
            {busy === 'draft' ? 'Drafting…' : text.trim() ? 'Draft again with AI' : 'Draft with AI'}
          </Button>
        )}
      </div>

      {mode === 'reply' && why ? (
        <p className="rounded-lg bg-muted/60 px-3 py-2.5 text-sm text-muted-foreground">{why}</p>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (text.trim()) void send()
          }}
        >
          <label htmlFor="ticket-composer" className="sr-only">
            {mode === 'reply' ? 'Your reply' : 'Your note'}
          </label>
          {/* While the AI writes: a sheen round the edge, the bot at work, then the draft typing itself in. */}
          <div data-motion={magic ? '' : undefined} className={cn('relative rounded-[8px]', magic && 'ai-sheen p-[1.5px]')}>
            <Textarea
              ref={box}
              id="ticket-composer"
              value={text}
              onChange={(e) => setText(e.target.value)}
              readOnly={magic}
              maxLength={TICKET_LIMITS.body}
              placeholder={busy === 'draft' ? '' : mode === 'reply' ? `Write to ${ticket.visitorName}…` : 'Only your team sees notes.'}
              className={cn('min-h-32 resize-y', mode === 'note' && 'border-dashed', magic && 'border-transparent focus-visible:outline-none')}
            />
            {busy === 'draft' && (
              <div className={cn('pointer-events-none absolute inset-[1.5px] flex items-start gap-2.5 rounded-md px-3 py-2.5', text && 'bg-card/90')}>
                <HelpBot mood="thinking" size={22} />
                <p key={step} data-motion="" className="ai-step pt-0.5 text-sm" aria-live="polite">
                  <span data-motion="" className="ai-shimmer-text">
                    {DRAFT_STEPS[step]}
                  </span>
                </p>
              </div>
            )}
            {typing && (
              <button
                type="button"
                onClick={showAll}
                className="absolute right-3 bottom-2.5 rounded-md bg-card px-1.5 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                Show all
              </button>
            )}
          </div>
          {mode === 'reply' && drafted && !typing && (
            <p className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground">
              <SparklesIcon size={13} className="mt-px shrink-0" />
              Drafted by AI from your help articles. Check it and fill in anything marked [add details] before sending.
            </p>
          )}
          {mode === 'reply' && (
            <p className="mt-2 text-xs text-muted-foreground">
              Goes to {ticket.email}, signed with your name, with their message quoted and a private link to read the ticket and reply.
              {data.email.replyTo && !noReply ? ` Their answer comes back to ${data.email.replyTo}.` : ''}
            </p>
          )}
          {mode === 'reply' && noReply && (
            <p className="mt-1.5 text-xs text-destructive">
              They can reply with the link in the email, but an answer to the email itself would go to {data.email.replyTo}, which looks like a no-reply address. Set SUPPORT_REPLY_TO to a mailbox your team reads, and restart.
            </p>
          )}
          {error && (
            <div className="mt-3">
              <Notice tone="error">{error}</Notice>
            </div>
          )}
          <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
            {mode === 'reply' && (
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                Then
                <Select value={then} onChange={(e) => setThen(e.target.value as TicketStatus)} className="w-52">
                  <option value="pending">Wait on the customer</option>
                  <option value="solved">Mark solved</option>
                  <option value="open">Keep it open</option>
                </Select>
              </label>
            )}
            {unfilled && <span className="mr-auto text-xs text-destructive">Fill in [add details] before sending.</span>}
            <Button type="submit" disabled={busy !== null || typing || !text.trim() || unfilled}>
              <BusyIcon busy={busy === 'send'} size={14} />
              {mode === 'reply' ? 'Send reply' : 'Add note'}
            </Button>
          </div>
        </form>
      )}
    </div>
  )
}
