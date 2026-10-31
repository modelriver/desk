import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/server/db.server.ts'
import { addCustomerMessage, addNote, createTicket, customerTicket, getTicket, recordReply, setTicketStatus, ticketsForEmail } from '../src/server/tickets.server.ts'
import {
  blockCustomer,
  blockedCustomers,
  confirmCustomerCode,
  createTicketLink,
  customerSessionEmail,
  endCustomerSession,
  isBlocked,
  issueCustomerCode,
  pruneTicketAccess,
  redeemTicketLink,
  startCustomerSession,
  unblockCustomer,
} from '../src/server/ticket-access.server.ts'
import { composeReplyEmail } from '../src/lib/ticket-core.ts'
import { saveAvatar } from '../src/server/avatars.server.ts'

const DAY = 86_400_000

function setup() {
  const db = openDb(':memory:')
  db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('sam', 'sam@acme.test', 'Sam', 'x', 'agent', 'now')").run()
  const t = createTicket(db, { visitorName: 'Jo', email: 'jo@example.test', emailVerified: true, text: 'Charged twice', source: 'chat' })
  return { db, ...t }
}

test('a reply email’s key opens only its ticket, for the ticket’s address, for 30 days', () => {
  const { db, id, ref } = setup()
  const other = createTicket(db, { visitorName: 'Al', email: 'al@example.test', text: 'Hi', source: 'chat' })
  const key = createTicketLink(db, id, 'jo@example.test')
  assert.equal(redeemTicketLink(db, ref, key), 'jo@example.test')
  // Another ticket's reference, a made-up key, or an expired one: nothing.
  assert.equal(redeemTicketLink(db, other.ref, key), null)
  assert.equal(redeemTicketLink(db, ref, 'x'.repeat(43)), null)
  assert.equal(redeemTicketLink(db, ref, key, Date.now() + 31 * DAY), null)
  // The ticket's email changed: old keys stop working.
  db.prepare("UPDATE tickets SET email = 'new@example.test' WHERE id = ?").run(id)
  assert.equal(redeemTicketLink(db, ref, key), null)
  // Keys are stored hashed.
  assert.equal((db.prepare('SELECT count(*) AS n FROM ticket_links WHERE token_hash = ?').get(key) as { n: number }).n, 0)
})

test('a customer session is an email address, for 14 days, until they sign out', () => {
  const { db } = setup()
  const token = startCustomerSession(db, 'jo@example.test')
  assert.equal(customerSessionEmail(db, token), 'jo@example.test')
  assert.equal(customerSessionEmail(db, token, Date.now() + 15 * DAY), null)
  assert.equal(customerSessionEmail(db, undefined), null)
  assert.equal(customerSessionEmail(db, 'not a token'), null)
  endCustomerSession(db, token)
  assert.equal(customerSessionEmail(db, token), null)
})

test('codes: right once, wrong five times locks for 15 minutes, expired after 10', () => {
  const { db } = setup()
  const code = issueCustomerCode(db, 'jo@example.test')
  confirmCustomerCode(db, 'jo@example.test', code)
  assert.throws(() => confirmCustomerCode(db, 'jo@example.test', code), /Ask for a code first/)

  const next = issueCustomerCode(db, 'jo@example.test')
  const wrong = next === '000000' ? '111111' : '000000'
  for (let i = 0; i < 4; i++) assert.throws(() => confirmCustomerCode(db, 'jo@example.test', wrong), /isn’t right/)
  assert.throws(() => confirmCustomerCode(db, 'jo@example.test', wrong), /Too many wrong codes/)
  assert.throws(() => confirmCustomerCode(db, 'jo@example.test', next), /Too many wrong codes/)
  assert.throws(() => issueCustomerCode(db, 'jo@example.test'), /Too many wrong codes/)

  const late = issueCustomerCode(db, 'al@example.test')
  assert.throws(() => confirmCustomerCode(db, 'al@example.test', late, Date.now() + 11 * 60_000), /expired/)
})

test('the customer sees their messages and sent replies, never notes; replying reopens it', () => {
  const { db, id, ref } = setup()
  addNote(id, 'Check Stripe first.', { id: 'sam', name: 'Sam' }, db)
  recordReply(id, 'Refunded.', { id: 'sam', name: 'Sam' }, { status: 'sent' }, 'solved', db)
  recordReply(id, 'Never went out.', { id: 'sam', name: 'Sam' }, { status: 'failed', error: 'x' }, 'pending', db)
  const view = customerTicket(ref, db)!
  assert.deepEqual(
    view.thread.map((m) => [m.from, m.name, m.body]),
    [
      ['customer', 'Jo', 'Charged twice'],
      ['team', 'Sam', 'Refunded.'],
    ],
  )
  assert.equal(view.status, 'solved')
  // No picture yet: the portal shows the bot. Once Sam sets one, their replies carry it; the customer's never do.
  assert.deepEqual(view.thread.map((m) => m.avatar), [null, null])
  const webp = new Uint8Array([...new TextEncoder().encode('RIFF'), 0, 0, 0, 0, ...new TextEncoder().encode('WEBPVP8 '), 1, 2, 3])
  const url = saveAvatar('sam', webp, db)
  assert.deepEqual(customerTicket(ref, db)!.thread.map((m) => m.avatar), [null, url])
  addCustomerMessage(id, 'Thanks, all good.', db)
  assert.equal(getTicket(id, db)!.status, 'open')
  assert.equal(customerTicket(ref, db)!.thread.at(-1)!.body, 'Thanks, all good.')
  setTicketStatus(id, 'pending', { id: 'sam', name: 'Sam' }, db)
  assert.equal(customerTicket('NOPE22', db), null)
})

test('expired keys, sessions and codes are cleaned up', () => {
  const { db, id } = setup()
  createTicketLink(db, id, 'jo@example.test', Date.now() - 31 * DAY)
  startCustomerSession(db, 'jo@example.test', Date.now() - 15 * DAY)
  issueCustomerCode(db, 'jo@example.test', Date.now() - 11 * 60_000)
  createTicketLink(db, id, 'jo@example.test')
  assert.equal(pruneTicketAccess(db), 3)
  assert.equal((db.prepare('SELECT count(*) AS n FROM ticket_links').get() as { n: number }).n, 1)
})

test('the reply email links to the ticket page', () => {
  const email = composeReplyEmail({
    ticketRef: 'K7F3Q9',
    subject: 'Billing',
    body: 'Refunded.',
    agentName: 'Sam',
    brand: 'Acme',
    original: null,
    link: 'https://help.acme.test/tickets/K7F3Q9?k=abc',
  })
  assert.match(email.text, /View the ticket and reply: https:\/\/help\.acme\.test\/tickets\/K7F3Q9\?k=abc/)
  assert.match(email.html, /href="https:\/\/help\.acme\.test\/tickets\/K7F3Q9\?k=abc"[^>]*>View ticket and reply</)
})

test('blocking an address ends its sessions and codes, and stops its links; unblocking lets it back', () => {
  const { db, id, ref } = setup()
  const key = createTicketLink(db, id, 'jo@example.test')
  const session = startCustomerSession(db, 'jo@example.test')
  issueCustomerCode(db, 'jo@example.test')
  blockCustomer(db, 'jo@example.test', { name: 'Sam' }, 'Spam')
  assert.equal(isBlocked(db, 'jo@example.test'), true)
  assert.equal(customerSessionEmail(db, session), null)
  assert.equal(redeemTicketLink(db, ref, key), null)
  assert.throws(() => confirmCustomerCode(db, 'jo@example.test', '123456'), /Ask for a code first/)
  assert.deepEqual(blockedCustomers(db).map((b) => [b.email, b.blockedBy, b.reason]), [['jo@example.test', 'Sam', 'Spam']])
  assert.equal(unblockCustomer(db, 'jo@example.test'), true)
  assert.equal(redeemTicketLink(db, ref, key), 'jo@example.test')
  assert.equal(isBlocked(db, null), false)
})

test('a portal shows the tickets raised with its address, newest activity first', () => {
  const { db, ref } = setup()
  const portal = createTicket(db, { visitorName: 'Jo', email: 'jo@example.test', emailVerified: true, subject: 'Second', text: 'Again', source: 'portal' })
  createTicket(db, { visitorName: 'Al', email: 'al@example.test', text: 'Not Jo’s', source: 'chat' })
  db.prepare("UPDATE tickets SET updated_at = '2000-01-01T00:00:00.000Z' WHERE ref = ?").run(ref)
  assert.deepEqual(ticketsForEmail('jo@example.test', db).map((t) => t.ref), [portal.ref, ref])
  assert.equal(getTicket(portal.id, db)!.source, 'portal')
})
