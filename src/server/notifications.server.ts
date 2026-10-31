import type { DatabaseSync } from 'node:sqlite'
import { getDb } from './db.server.ts'
import { env } from './env.server.ts'
import { allow } from './rate-limit.server.ts'
import { emailStatus, sendEmail, type Email } from './email.server.ts'
import { getSiteConfig } from './site-config.server.ts'
import { escapeHtml } from '../lib/escape.ts'
import { errorMessage } from '../lib/errors.ts'
import { queueEmail } from './outbox.server.ts'

// Email notifications for the team. Each person chooses in their account:
// - someone is waiting for a person (asked, or the AI couldn't answer)
// - a new conversation started (once per conversation, never per message)
// - every new ticket a visitor or customer raises (and replies on tickets
//   nobody has yet)
// - their own tickets: one assigned to them by someone else, or the
//   customer replied on it
// Nobody is told about what they did themselves. Events are gathered for a
// few seconds and sent as one email per person, and each person gets at most
// MAX_PER_HOUR emails, so a busy day can't flood inboxes. An email that fails
// is retried (see outbox.server.ts).

export type NotificationEvent = {
  kind: 'handoff' | 'new_conversation' | 'ticket' | 'ticket_reply' | 'ticket_assigned'
  reason?: 'asked' | 'ai_error'
  visitorName: string
  sessionId: string | null
  // For a ticket: its reference (K7F3Q9).
  ticketRef?: string
  // ticket_assigned: who it's now assigned to, and who did it (visitorName is unused).
  assigneeId?: string
  actor?: { id: string; name: string }
  // The visitor's message, when there is one.
  text: string | null
  at: string
}

type Recipient = {
  id: string
  name: string
  email: string
  notify_handoff: number
  notify_new_conversations: number
  notify_new_tickets: number
  notify_my_tickets: number
}

const FLUSH_MS = 15_000
const MAX_PER_HOUR = 20

const queue: NotificationEvent[] = []
let timer: ReturnType<typeof setTimeout> | undefined

export function notifyTeam(event: Omit<NotificationEvent, 'at'>) {
  // Nothing to do without email; don't hold events in memory.
  if (!emailStatus().ready) return
  queue.push({ ...event, at: new Date().toISOString() })
  if (!timer) {
    timer = setTimeout(() => void flushNotifications(), FLUSH_MS)
    timer.unref?.()
  }
}

// Who wants which events. A customer's reply goes to whoever has the ticket
// now (looked up at send time), or, when nobody has it, to everyone who
// follows new tickets.
export function recipientsFor(db: DatabaseSync, events: NotificationEvent[]): Array<{ user: Recipient; events: NotificationEvent[] }> {
  const users = db
    .prepare(
      `SELECT id, name, email, notify_handoff, notify_new_conversations, notify_new_tickets, notify_my_tickets FROM users
       WHERE notify_handoff = 1 OR notify_new_conversations = 1 OR notify_new_tickets = 1 OR notify_my_tickets = 1`,
    )
    .all() as Recipient[]
  const refs = [...new Set(events.flatMap((e) => (e.kind === 'ticket_reply' && e.ticketRef ? [e.ticketRef] : [])))]
  const owners = new Map(
    refs.length
      ? (db.prepare(`SELECT ref, assignee_id FROM tickets WHERE ref IN (${refs.map(() => '?').join(', ')})`).all(...refs) as Array<{ ref: string; assignee_id: string | null }>).map(
          (r) => [r.ref, r.assignee_id],
        )
      : [],
  )
  const wants = (user: Recipient, e: NotificationEvent): boolean => {
    if (e.actor?.id === user.id) return false
    switch (e.kind) {
      case 'handoff':
        return user.notify_handoff === 1
      case 'new_conversation':
        return user.notify_new_conversations === 1
      case 'ticket':
        return user.notify_new_tickets === 1
      case 'ticket_assigned':
        return e.assigneeId === user.id && user.notify_my_tickets === 1
      case 'ticket_reply': {
        const owner = owners.get(e.ticketRef ?? '') ?? null
        return owner ? owner === user.id && user.notify_my_tickets === 1 : user.notify_new_tickets === 1
      }
    }
  }
  return users.map((user) => ({ user, events: events.filter((e) => wants(user, e)) })).filter((r) => r.events.length > 0)
}

export async function flushNotifications(db: DatabaseSync = getDb(), send: (email: Email) => Promise<void> = sendEmail) {
  timer = undefined
  const events = queue.splice(0)
  if (!events.length) return
  const brand = getSiteConfig().config.brand.name
  for (const { user, events: mine } of recipientsFor(db, events)) {
    if (!allow(`notify:${user.id}`, MAX_PER_HOUR, 60 * 60_000)) continue
    const email = { to: user.email, ...composeNotification(mine, { brand, appUrl: env.appUrl }) }
    try {
      await send(email)
    } catch (err) {
      console.error(`[notifications] couldn’t email ${user.email}; trying again later`, err)
      queueEmail(email, { kind: 'notification', error: errorMessage(err, 'the email provider refused it') }, db)
    }
  }
}

// --- The email itself ---

function describe(e: NotificationEvent): string {
  if (e.kind === 'new_conversation') return `New conversation from ${e.visitorName}`
  if (e.kind === 'ticket') return `${e.visitorName} raised ticket #${e.ticketRef}`
  if (e.kind === 'ticket_reply') return `${e.visitorName} replied on ticket #${e.ticketRef}`
  if (e.kind === 'ticket_assigned') return `${e.actor?.name ?? 'Someone'} assigned you ticket #${e.ticketRef}`
  return e.reason === 'ai_error' ? `The AI couldn’t answer ${e.visitorName}` : `${e.visitorName} wants to talk to a person`
}

function link(e: NotificationEvent, appUrl: string): string | null {
  if (!appUrl) return null
  if (e.ticketRef) return `${appUrl}/dashboard/tickets/${e.ticketRef}`
  return e.sessionId ? `${appUrl}/dashboard/c/${e.sessionId}` : `${appUrl}/dashboard`
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 280 ? `${flat.slice(0, 280)}…` : flat
}

export function composeNotification(events: NotificationEvent[], { brand, appUrl }: { brand: string; appUrl: string }) {
  const waiting = events.filter((e) => e.kind === 'handoff').length
  const subject =
    events.length === 1
      ? describe(events[0]!)
      : waiting === events.length
        ? `${waiting} people are waiting for the team`
        : `${events.length} updates from ${brand}`

  const settings = appUrl ? `${appUrl}/dashboard/account` : null
  const footer = `You get these emails because notifications are on in your ${brand} account${settings ? `: ${settings}` : '.'}`

  const text = [
    ...events.map((e) => {
      const url = link(e, appUrl)
      return [describe(e), e.text ? `“${excerpt(e.text)}”` : null, url ? `Open: ${url}` : null].filter(Boolean).join('\n')
    }),
    footer,
  ].join('\n\n')

  const html = [
    '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:14px;line-height:1.5;color:#111">',
    ...events.map((e) => {
      const url = link(e, appUrl)
      return [
        '<div style="margin:0 0 20px">',
        `<p style="margin:0;font-weight:600">${escapeHtml(describe(e))}</p>`,
        e.text ? `<p style="margin:4px 0 0;color:#555">“${escapeHtml(excerpt(e.text))}”</p>` : '',
        url ? `<p style="margin:6px 0 0"><a href="${escapeHtml(url)}" style="color:#111">${e.ticketRef ? 'Open the ticket' : 'Open the conversation'}</a></p>` : '',
        '</div>',
      ].join('')
    }),
    `<p style="margin:24px 0 0;font-size:12px;color:#777">${escapeHtml(footer)}</p>`,
    '</div>',
  ].join('')

  return { subject, text, html }
}
