import { createServerFn } from '@tanstack/react-start'
import { asObject, str } from './validate.ts'
import { getDb } from '../server/db.server.ts'
import { clientIp } from '../server/auth.server.ts'
import { allowAll } from '../server/rate-limit.server.ts'
import { emailStatus, sendEmail } from '../server/email.server.ts'
import { getSiteConfig } from '../server/site-config.server.ts'
import { normalizeEmail } from '../server/identity.server.ts'
import { maskEmail } from '../server/integrations.server.ts'
import { notifyTeam } from '../server/notifications.server.ts'
import { sendTicketConfirmation } from '../server/ticket-emails.server.ts'
import { ticketSubjectNames } from '../server/ticket-subjects.server.ts'
import { TICKETS_OFF_MESSAGE, ticketsEnabled } from '../server/chat-availability.server.ts'
import { addCustomerMessage, createTicket, customerTicket, ticketsForEmail, type CustomerTicket } from '../server/tickets.server.ts'
import {
  AccessError,
  confirmCustomerCode as confirmCode,
  customerSessionEmail,
  endCustomerSession,
  isBlocked,
  issueCustomerCode,
  redeemTicketLink,
  startCustomerSession,
} from '../server/ticket-access.server.ts'
import { clearCustomerCookie, readCustomerCookie, writeCustomerCookie } from '../server/customer-cookie.server.ts'
import { escapeHtml } from '../lib/escape.ts'
import { normalizeTicketRef, TICKET_LIMITS, TICKETS_PER_EMAIL_PER_DAY } from '../lib/ticket-core.ts'

// The customer portal (/customer-portal): customers sign in with their email
// and a 6-digit code (or the private link in a reply email), see the tickets
// raised with that address, reply, and raise new ones. See ticket-access.server.ts.
//
// Spam and probing: codes go to any address, so no answer here says whether an
// address has tickets or is blocked; code emails are sent in the background so
// timing doesn't tell either. Every step is rate limited per address, per IP and
// site-wide (see LIMITS). Blocked addresses get no codes, sessions or links.

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

class CustomerError extends Error {}

async function customerSafe<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof CustomerError) throw err
    if (err instanceof AccessError) throw new CustomerError(err.message)
    console.error('[portal]', err)
    throw new Error('Something went wrong. Please try again in a moment.')
  }
}

function refFrom(input: Record<string, unknown>): string {
  const ref = normalizeTicketRef(input.ref)
  if (!ref) throw new Error('That isn’t a ticket reference.')
  return ref
}

function limited(limits: Parameters<typeof allowAll>[0], message: string) {
  if (!allowAll(limits)) throw new CustomerError(message)
}

// The signed-in address, or null (no session, it ended, or it was blocked).
function sessionEmail(): string | null {
  return customerSessionEmail(getDb(), readCustomerCookie())
}

// A ticket as the customer sees it: never the row id or the full address.
function view(t: CustomerTicket, email: string) {
  const { id: _id, email: _email, ...rest } = t
  return { state: 'ticket' as const, ticket: rest, signedInAs: maskEmail(email) }
}

function signedOut() {
  return { state: 'sign-in' as const, canEmail: emailStatus().ready }
}

// The portal's home: the signed-in customer's tickets, or the sign-in form.
export const getPortal = createServerFn({ method: 'POST' }).handler(() =>
  customerSafe(() => {
    const email = sessionEmail()
    if (!email) return signedOut()
    return { state: 'home' as const, signedInAs: maskEmail(email), tickets: ticketsForEmail(email), canRaise: ticketsEnabled(), subjects: ticketSubjectNames() }
  }),
)

// Step 1 of signing in: a code to the address. The same answer whatever the
// address, and the email goes out in the background.
export const requestPortalCode = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const email = normalizeEmail(asObject(input).email)
    if (!email) throw new Error('Enter a valid email address.')
    return { email }
  })
  .handler(({ data }) =>
    customerSafe(() => {
      const ip = clientIp()
      limited(
        [
          { key: `portal-code-ip:${ip}`, max: 10, windowMs: 10 * MINUTE },
          { key: `portal-code-ip-day:${ip}`, max: 30, windowMs: DAY },
          { key: `portal-code-email:${data.email}`, max: 3, windowMs: 10 * MINUTE },
          { key: `portal-code-email-day:${data.email}`, max: 10, windowMs: DAY },
          { key: 'portal-code-global', max: 200, windowMs: HOUR },
        ],
        'That’s a few codes already. Please wait a few minutes.',
      )
      if (!emailStatus().ready) throw new CustomerError('Codes can’t be sent right now. Please try again later.')
      const db = getDb()
      if (!isBlocked(db, data.email)) {
        const code = issueCustomerCode(db, data.email)
        const brand = getSiteConfig().config.brand.name
        void sendEmail({
          to: data.email,
          subject: `${code} is your ${brand} sign-in code`,
          text: `Your ${brand} sign-in code is ${code}.\n\nIt expires in 10 minutes. Enter it to see your tickets.\n\nIf you didn’t ask for this, you can ignore this email.`,
          html: `<div style="font-family:system-ui,sans-serif"><p>Your ${escapeHtml(brand)} sign-in code is</p><p style="font-size:28px;font-weight:600;letter-spacing:4px">${code}</p><p>It expires in 10 minutes. Enter it to see your tickets.</p><p style="color:#666">If you didn’t ask for this, you can ignore this email.</p></div>`,
        }).catch((err) => console.error('[portal] couldn’t send a sign-in code', err))
      }
      return { sentTo: maskEmail(data.email) }
    }),
  )

// Step 2: the code. Five wrong codes lock the address for 15 minutes.
export const confirmPortalCode = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const o = asObject(input)
    const email = normalizeEmail(o.email)
    if (!email) throw new Error('Enter a valid email address.')
    return { email, code: str(o, 'code', { max: 12 }) }
  })
  .handler(({ data }) =>
    customerSafe(() => {
      limited([{ key: `portal-check-ip:${clientIp()}`, max: 30, windowMs: 10 * MINUTE }], 'Too many attempts. Please wait a few minutes.')
      const db = getDb()
      confirmCode(db, data.email, data.code)
      writeCustomerCookie(startCustomerSession(db, data.email))
      return { signedInAs: maskEmail(data.email) }
    }),
  )

// A ticket, for its own address only. The private key from a reply email signs
// them in on the way (?k=); otherwise their session must be for this ticket's address.
export const openCustomerTicket = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const o = asObject(input)
    const key = typeof o.key === 'string' && o.key.length <= 100 ? o.key : null
    return { ref: refFrom(o), key }
  })
  .handler(({ data }) =>
    customerSafe(() => {
      limited([{ key: `portal-open-ip:${clientIp()}`, max: 120, windowMs: 10 * MINUTE }], 'Too many requests. Please wait a moment.')
      const db = getDb()
      const ticket = customerTicket(data.ref, db)
      if (data.key && ticket) {
        const email = redeemTicketLink(db, data.ref, data.key)
        if (email) {
          writeCustomerCookie(startCustomerSession(db, email))
          return view(ticket, email)
        }
      }
      const email = customerSessionEmail(db, readCustomerCookie())
      if (ticket && email && ticket.email === email) return view(ticket, email)
      // Signed in as someone else, or no such ticket: the same answer.
      if (email) return { state: 'not-yours' as const, ref: data.ref, signedInAs: maskEmail(email) }
      return { ...signedOut(), ref: data.ref, linkExpired: Boolean(data.key) }
    }),
  )

// The customer's answer: on the ticket, which opens again, and the team hears about it.
export const replyAsCustomer = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const o = asObject(input)
    return { ref: refFrom(o), text: str(o, 'text', { max: TICKET_LIMITS.message }) }
  })
  .handler(({ data }) =>
    customerSafe(() => {
      const db = getDb()
      const email = customerSessionEmail(db, readCustomerCookie())
      const ticket = customerTicket(data.ref, db)
      if (!ticket || !email || ticket.email !== email) throw new CustomerError('Your sign-in has ended. Sign in again to reply.')
      limited(
        [
          { key: `portal-reply:${email}`, max: 20, windowMs: HOUR },
          { key: `portal-reply-ip:${clientIp()}`, max: 60, windowMs: HOUR },
        ],
        'That’s a lot of replies in an hour. Please wait a little.',
      )
      addCustomerMessage(ticket.id, data.text, db)
      notifyTeam({ kind: 'ticket_reply', ticketRef: ticket.ref, visitorName: ticket.visitorName, sessionId: null, text: data.text })
      return view(customerTicket(data.ref, db)!, email)
    }),
  )

// A new ticket from the portal, for the signed-in address (already proven).
export const raisePortalTicket = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const o = asObject(input)
    const name = typeof o.name === 'string' ? o.name.trim().slice(0, 60) : ''
    return { name, subject: str(o, 'subject', { max: TICKET_LIMITS.subject }), text: str(o, 'text', { max: TICKET_LIMITS.message }) }
  })
  .handler(({ data }) =>
    customerSafe(() => {
      if (!ticketsEnabled()) throw new CustomerError(TICKETS_OFF_MESSAGE)
      const email = sessionEmail()
      if (!email) throw new CustomerError('Your sign-in has ended. Sign in again to raise a ticket.')
      limited(
        [
          { key: `portal-ticket:${email}`, max: 3, windowMs: HOUR },
          { key: `customer-tickets-day:${email}`, max: TICKETS_PER_EMAIL_PER_DAY, windowMs: DAY },
          { key: `portal-ticket-ip-day:${clientIp()}`, max: 10, windowMs: DAY },
          { key: 'portal-ticket-global', max: 200, windowMs: HOUR },
        ],
        'That’s a lot of tickets for now. Please add to one you’ve already raised, or try again later.',
      )
      const db = getDb()
      const { id, ref } = createTicket(db, {
        visitorName: data.name || email.split('@')[0]!,
        email,
        emailVerified: true,
        subject: data.subject,
        text: data.text,
        source: 'portal',
      })
      notifyTeam({ kind: 'ticket', ticketRef: ref, visitorName: data.name || email, sessionId: null, text: data.text })
      sendTicketConfirmation({ id, ref, email, message: data.text }, db)
      return { ref }
    }),
  )

export const signOutCustomer = createServerFn({ method: 'POST' }).handler(() => {
  endCustomerSession(getDb(), readCustomerCookie())
  clearCustomerCookie()
  return { ok: true }
})
