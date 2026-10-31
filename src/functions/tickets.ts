import { createServerFn } from '@tanstack/react-start'
import { asObject, oneOf, str, uuid } from './validate.ts'
import { requireUser } from '../server/auth.server.ts'
import { getDb } from '../server/db.server.ts'
import { env } from '../server/env.server.ts'
import { allow, allowAll } from '../server/rate-limit.server.ts'
import { emailStatus, sendEmail, type Email } from '../server/email.server.ts'
import { queuedReplies, queueEmail, takeQueuedReply } from '../server/outbox.server.ts'
import { notifyTeam } from '../server/notifications.server.ts'
import { addTicketSubject, listTicketSubjects, moveTicketSubject, removeTicketSubject, TicketSubjectError } from '../server/ticket-subjects.server.ts'
import { getSiteConfig } from '../server/site-config.server.ts'
import { searchContent } from '../server/content.server.ts'
import { siteUrl } from '../server/seo.server.ts'
import { avatarsByName } from '../server/avatars.server.ts'
import * as mr from '../server/modelriver.server.ts'
import { recordAiAccepted, recordAiFailure } from '../server/status.server.ts'
import { blockCustomer, blockedCustomers, createTicketLink, isBlocked, unblockCustomer } from '../server/ticket-access.server.ts'
import { audit } from '../server/integrations.server.ts'
import { normalizeEmail } from '../server/identity.server.ts'
import { errorMessage } from '../lib/errors.ts'
import { PAGE_SIZE, pageNumber, pageOf } from '../lib/paging.ts'
import { buildDraftMessages, cleanDraft, composeReplyEmail, normalizeTicketRef, ticketThreadHeaders, textFromModel, TICKET_LIMITS, TICKET_STATUSES, type TicketStatus } from '../lib/ticket-core.ts'
import {
  addNote,
  assignTicket,
  createTicket,
  deleteTicket,
  failedReply,
  forgetDraftSession,
  getTicket,
  listTickets,
  recordReply,
  rememberDraftSession,
  replyFailedAgain,
  replySentAgain,
  setTicketStatus,
  ticketCounts,
  ticketIdByRef,
  ticketThread,
  TicketError,
} from '../server/tickets.server.ts'

// The team's side of tickets (see tickets.server.ts). Any team member can
// work on any ticket; deleting one is for admins.

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

function ticketId(o: Record<string, unknown>, key = 'id'): number {
  const n = o[key]
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) throw new Error(`${key} is invalid.`)
  return n
}

function status(o: Record<string, unknown>, key: string): TicketStatus {
  return oneOf(o, key, TICKET_STATUSES)
}

// TicketError messages are written for the team; anything else is generic.
async function safely<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof TicketError || err instanceof TicketSubjectError) throw new Error(err.message)
    throw err
  }
}

export const listTicketsPage = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    const o = asObject(input ?? {})
    return {
      view: oneOf(o, 'view', ['open', 'pending', 'solved'] as const),
      assignee: oneOf(o, 'assignee', ['all', 'mine', 'unassigned'] as const),
      page: pageNumber(o.page),
    }
  })
  .handler(({ data }) => {
    const me = requireUser()
    const db = getDb()
    const counts = ticketCounts({ assignee: data.assignee, userId: me.id }, db)
    const paging = pageOf(counts[data.view], data.page)
    const { tickets } = listTickets({ ...data, userId: me.id, limit: PAGE_SIZE, offset: paging.offset }, db)
    return { tickets, counts, ...paging, currentUserId: me.id }
  })

// One ticket, by its reference, with its history, the team (for assigning),
// and whether replies and drafts can go out.
export const getTicketPage = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const ref = normalizeTicketRef(asObject(input).ref)
    if (!ref) throw new Error('That isn’t a ticket reference.')
    return { ref }
  })
  .handler(({ data }) => {
    const me = requireUser()
    const db = getDb()
    const id = ticketIdByRef(data.ref, db)
    const ticket = id === null ? null : getTicket(id, db)
    if (!ticket) throw new Error('That ticket doesn’t exist, or was deleted.')
    const team = db.prepare('SELECT id, name FROM users ORDER BY name').all() as Array<{ id: string; name: string }>
    const avatars = avatarsByName(team.map((u) => u.name), db)
    return {
      ticket,
      team: team.map((u) => ({ ...u, avatar: avatars.get(u.name) ?? null })),
      me: { id: me.id, role: me.role },
      email: { ready: emailStatus().ready, replyTo: env.supportReplyTo || env.emailFrom || null },
      // The customer's address is blocked from the portal and from raising tickets.
      blocked: isBlocked(db, ticket.email),
      canDraft: Boolean(env.modelriverApiKey),
      // Failed replies Desk is still retrying (see outbox.server.ts).
      retrying: [...queuedReplies(ticket.events.filter((e) => e.emailStatus === 'failed').map((e) => e.id), db).keys()],
    }
  })

// A reply to the customer, by email. Kept even when the email fails (marked,
// with a way to send it again) so the text isn't lost.
export const replyToTicket = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const o = asObject(input)
    return { id: ticketId(o), body: str(o, 'body', { max: TICKET_LIMITS.body }), then: status(o, 'then') }
  })
  .handler(({ data }) =>
    safely(async () => {
      const me = requireUser()
      if (!allow(`ticket-reply:${me.id}`, 120, HOUR)) throw new Error('That’s a lot of replies in an hour. Please wait a little.')
      const db = getDb()
      const ticket = getTicket(data.id, db)
      if (!ticket) throw new TicketError('That ticket no longer exists.')
      if (!ticket.email) throw new TicketError('This ticket has no email address to reply to. Add a note instead, or reply in the chat.')
      if (!emailStatus().ready) throw new TicketError('Email isn’t set up on this server, so replies can’t be sent. Set EMAIL_PROVIDER and restart.')
      const result = await sendReply(ticket, data.body, me.name)
      const eventId = recordReply(data.id, data.body, { id: me.id, name: me.name }, result, data.then, db)
      if (result.status === 'failed') {
        queueEmail(result.email, { kind: 'reply', error: result.error, ticketEventId: eventId, thenStatus: data.then }, db)
        throw new TicketError(`The reply is saved, but the email couldn’t be sent: ${result.error}. Desk will keep trying for about 16 hours.`)
      }
      return { ok: true }
    }),
  )

// Each email carries its own private link to the ticket's page, which signs
// the customer in to read the replies and answer (see ticket-access.server.ts).
async function sendReply(ticket: NonNullable<ReturnType<typeof getTicket>>, body: string, agentName: string) {
  const original = ticket.events.find((e) => e.kind === 'message')?.body ?? null
  const key = createTicketLink(getDb(), ticket.id, ticket.email!)
  const link = `${siteUrl()}/customer-portal/tickets/${ticket.ref}?k=${key}`
  const email: Email = {
    to: ticket.email!,
    ...composeReplyEmail({ ticketRef: ticket.ref, subject: ticket.subject, body, agentName, brand: getSiteConfig().config.brand.name, original, link }),
    ...(env.supportReplyTo ? { replyTo: env.supportReplyTo } : {}),
    headers: ticketThreadHeaders(ticket.ref, env.emailFrom),
  }
  try {
    await sendEmail(email)
    return { status: 'sent' as const }
  } catch (err) {
    return { status: 'failed' as const, error: errorMessage(err, 'the email provider refused it'), email }
  }
}

// Sends a reply whose email failed, again.
export const resendTicketReply = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const o = asObject(input)
    return { eventId: ticketId(o, 'eventId'), then: status(o, 'then') }
  })
  .handler(({ data }) =>
    safely(async () => {
      const me = requireUser()
      if (!allow(`ticket-reply:${me.id}`, 120, HOUR)) throw new Error('That’s a lot of replies in an hour. Please wait a little.')
      const db = getDb()
      const reply = failedReply(data.eventId, db)
      const ticket = getTicket(reply.ticketId, db)
      if (!ticket?.email) throw new TicketError('This ticket has no email address to reply to.')
      // Its automatic retry is taken out first, so the reply can't go twice.
      takeQueuedReply(data.eventId, db)
      const result = await sendReply(ticket, reply.body, reply.authorName)
      if (result.status === 'failed') {
        replyFailedAgain(data.eventId, result.error, db)
        queueEmail(result.email, { kind: 'reply', error: result.error, ticketEventId: data.eventId, thenStatus: data.then }, db)
        throw new TicketError(`The email still couldn’t be sent: ${result.error}. Desk will keep trying for about 16 hours.`)
      }
      replySentAgain(data.eventId, { id: me.id, name: me.name }, data.then, db)
      return { ok: true }
    }),
  )

export const addTicketNote = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const o = asObject(input)
    return { id: ticketId(o), body: str(o, 'body', { max: TICKET_LIMITS.body }) }
  })
  .handler(({ data }) =>
    safely(() => {
      const me = requireUser()
      addNote(data.id, data.body, { id: me.id, name: me.name })
      return { ok: true }
    }),
  )

export const changeTicketStatus = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const o = asObject(input)
    return { id: ticketId(o), status: status(o, 'status') }
  })
  .handler(({ data }) =>
    safely(() => {
      const me = requireUser()
      setTicketStatus(data.id, data.status, { id: me.id, name: me.name })
      return { ok: true }
    }),
  )

export const assignTicketTo = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const o = asObject(input)
    return { id: ticketId(o), assigneeId: o.assigneeId === null ? null : uuid(o, 'assigneeId') }
  })
  .handler(({ data }) =>
    safely(() => {
      const me = requireUser()
      const db = getDb()
      const before = db.prepare('SELECT ref, subject, assignee_id FROM tickets WHERE id = ?').get(data.id) as { ref: string; subject: string; assignee_id: string | null } | undefined
      assignTicket(data.id, data.assigneeId, { id: me.id, name: me.name }, db)
      // Tell the new assignee (never someone assigning it to themselves; see recipientsFor).
      if (before && data.assigneeId && data.assigneeId !== before.assignee_id) {
        notifyTeam({ kind: 'ticket_assigned', ticketRef: before.ref, assigneeId: data.assigneeId, actor: { id: me.id, name: me.name }, visitorName: '', sessionId: null, text: before.subject })
      }
      return { ok: true }
    }),
  )

// Opened by a team member: from a chat (`sessionId`: its visitor, and their
// verified email unless another is given), or from a call or an email.
export const openTicket = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const o = asObject(input)
    const rawEmail = typeof o.email === 'string' ? o.email.trim() : ''
    const email = rawEmail ? normalizeEmail(rawEmail) : null
    if (rawEmail && !email) throw new Error('Enter a valid email address, or leave it empty.')
    return {
      name: typeof o.name === 'string' ? o.name.trim().slice(0, 60) : '',
      email,
      subject: str(o, 'subject', { max: TICKET_LIMITS.subject }),
      text: str(o, 'text', { max: TICKET_LIMITS.body }),
      sessionId: o.sessionId === undefined || o.sessionId === null ? null : uuid(o, 'sessionId'),
    }
  })
  .handler(({ data }) =>
    safely(() => {
      const me = requireUser()
      const db = getDb()
      const conv = data.sessionId
        ? (db.prepare('SELECT id, visitor_name, verified_email FROM conversations WHERE modelriver_session_id = ?').get(data.sessionId) as
            | { id: string; visitor_name: string; verified_email: string | null }
            | undefined)
        : undefined
      const name = data.name || conv?.visitor_name || ''
      if (!name) throw new TicketError('Add the customer’s name.')
      const email = data.email ?? conv?.verified_email ?? null
      const { ref } = createTicket(db, {
        conversationId: conv?.id ?? null,
        sessionId: conv ? data.sessionId : null,
        visitorName: name,
        email,
        emailVerified: Boolean(email && conv?.verified_email && email === conv.verified_email),
        subject: data.subject,
        text: data.text,
        source: 'team',
        createdBy: me.name,
      })
      return { ref }
    }),
  )

export const removeTicket = createServerFn({ method: 'POST' })
  .validator((input: unknown) => ({ id: ticketId(asObject(input)) }))
  .handler(({ data }) => {
    requireUser('admin')
    deleteTicket(data.id)
    return { ok: true }
  })

// An AI-drafted reply for the team to edit and send, from the help articles
// and the ticket so far (never its internal notes). It's one model request:
// counted in the site-wide AI caps, and limited per team member. The request
// starts a ModelRiver session (the workflow keeps memory); it's deleted at once.
export const draftTicketReply = createServerFn({ method: 'POST' })
  .validator((input: unknown) => ({ id: ticketId(asObject(input)) }))
  .handler(({ data }) =>
    safely(async () => {
      const me = requireUser()
      if (!allow(`ticket-draft:${me.id}`, 30, HOUR)) throw new Error('That’s a lot of drafts in an hour. Please wait a little.')
      const withinBudget = allowAll([
        { key: 'ai-global-minute', max: env.globalMessagesPerMinute, windowMs: MINUTE },
        { key: 'ai-global-day', max: env.globalMessagesPerDay, windowMs: DAY },
      ])
      if (!withinBudget) throw new Error('The site-wide AI limit is used up for now. Write this one yourself, or try again later.')
      const { ticket, turns } = ticketThread(data.id)
      const latest = [...turns].reverse().find((t) => t.from === 'customer')?.body ?? ticket.subject
      const messages = buildDraftMessages({
        chunks: searchContent(`${ticket.subject}\n${latest}`, 6),
        turns,
        customerName: ticket.visitorName,
        siteUrl: siteUrl(),
      })
      let res: Awaited<ReturnType<typeof mr.requestOnce>>
      try {
        res = await mr.requestOnce({ messages, metadata: { purpose: 'ticket_draft', ticket: String(ticket.id) } })
      } catch (err) {
        recordAiFailure(errorMessage(err, 'An AI draft failed'))
        throw new Error('Couldn’t write a draft just now. Try again, or write it yourself.')
      }
      recordAiAccepted()
      if (res.sessionId) void discardDraftSession(res.sessionId)
      const draft = cleanDraft(textFromModel(res.data))
      if (!draft) throw new Error('The draft came back empty. Try again, or write it yourself.')
      return { draft }
    }),
  )

// Out of the inbox at once, and deleted in ModelRiver; if deleting fails, it
// stays hidden and the hourly cleanup tries again (see cleanupDraftSessions).
async function discardDraftSession(sessionId: string) {
  rememberDraftSession(sessionId)
  try {
    await mr.deleteSession(sessionId)
    forgetDraftSession(sessionId)
  } catch (err) {
    console.error('[tickets] couldn’t delete a draft’s session; it stays out of the inbox', err)
  }
}

// --- Blocked customers ---
// Any team member can block an address: no codes, portal sign-ins, links,
// tickets or replies from it (see ticket-access.server.ts). Recorded in the audit log.

function blockedEmail(o: Record<string, unknown>): string {
  const email = normalizeEmail(o.email)
  if (!email) throw new Error('Enter a valid email address.')
  return email
}

export const listBlockedCustomers = createServerFn({ method: 'GET' }).handler(() => {
  requireUser()
  return { blocked: blockedCustomers() }
})

export const blockCustomerEmail = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const o = asObject(input)
    const reason = typeof o.reason === 'string' && o.reason.trim() ? o.reason.trim().slice(0, 200) : null
    return { email: blockedEmail(o), reason }
  })
  .handler(({ data }) => {
    const me = requireUser()
    const db = getDb()
    blockCustomer(db, data.email, me, data.reason)
    audit(db, me, 'customer.blocked', data.email)
    return { ok: true }
  })

export const unblockCustomerEmail = createServerFn({ method: 'POST' })
  .validator((input: unknown) => ({ email: blockedEmail(asObject(input)) }))
  .handler(({ data }) => {
    const me = requireUser()
    const db = getDb()
    if (unblockCustomer(db, data.email)) audit(db, me, 'customer.unblocked', data.email)
    return { ok: true }
  })

// The subjects customers pick from when they raise a ticket. Everyone on the
// team can see them; admins change them.
export const listTicketSubjectsPage = createServerFn({ method: 'GET' }).handler(() => {
  const me = requireUser()
  return { subjects: listTicketSubjects(), canEdit: me.role === 'admin' }
})

export const addTicketSubjectName = createServerFn({ method: 'POST' })
  .validator((input: unknown) => ({ name: str(asObject(input), 'name', { max: 200 }) }))
  .handler(({ data }) =>
    safely(() => {
      const me = requireUser('admin')
      const db = getDb()
      const subject = addTicketSubject(data.name, db)
      audit(db, me, 'ticket_subject.added', subject.name)
      return { ok: true }
    }),
  )

export const removeTicketSubjectName = createServerFn({ method: 'POST' })
  .validator((input: unknown) => ({ id: ticketId(asObject(input)) }))
  .handler(({ data }) => {
    const me = requireUser('admin')
    const db = getDb()
    const name = removeTicketSubject(data.id, db)
    if (name) audit(db, me, 'ticket_subject.removed', name)
    return { ok: true }
  })

export const moveTicketSubjectName = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const o = asObject(input)
    if (o.by !== -1 && o.by !== 1) throw new Error('by is invalid.')
    return { id: ticketId(o), by: o.by as -1 | 1 }
  })
  .handler(({ data }) => {
    requireUser('admin')
    moveTicketSubject(data.id, data.by)
    return { ok: true }
  })
