import type { DatabaseSync } from 'node:sqlite'
import { getDb } from './db.server.ts'
import { env } from './env.server.ts'
import { sendOrQueue } from './outbox.server.ts'
import { siteUrl } from './seo.server.ts'
import { getSiteConfig } from './site-config.server.ts'
import { createTicketLink } from './ticket-access.server.ts'
import { composeTicketConfirmation, ticketThreadHeaders } from '../lib/ticket-core.ts'

// The email a customer gets when they raise a ticket (from the chat or the
// customer portal; not when the team opens one): its reference and a link
// that opens it in the portal, signed in. Sent in the background and queued
// if it fails, so raising the ticket never waits on, or fails with, the email.
export function sendTicketConfirmation(ticket: { id: number; ref: string; email: string; message: string }, db: DatabaseSync = getDb()): void {
  const row = db.prepare('SELECT subject FROM tickets WHERE id = ?').get(ticket.id) as { subject: string } | undefined
  if (!row) return
  const link = `${siteUrl()}/customer-portal/tickets/${ticket.ref}?k=${createTicketLink(db, ticket.id, ticket.email)}`
  const email = {
    to: ticket.email,
    ...composeTicketConfirmation({ ticketRef: ticket.ref, subject: row.subject, brand: getSiteConfig().config.brand.name, message: ticket.message, link }),
    ...(env.supportReplyTo ? { replyTo: env.supportReplyTo } : {}),
    headers: ticketThreadHeaders(ticket.ref, env.emailFrom),
  }
  void sendOrQueue(email, { kind: 'confirmation' }, db)
}
