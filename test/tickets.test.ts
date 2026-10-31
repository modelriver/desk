import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { MIGRATIONS, migrate, openDb } from '../src/server/db.server.ts'
import {
  addNote,
  assignTicket,
  createTicket,
  draftSessions,
  failedReply,
  forgetDraftSession,
  getTicket,
  listTickets,
  openTicketCount,
  pruneTickets,
  recordReply,
  rememberDraftSession,
  replySentAgain,
  setTicketStatus,
  ticketCounts,
  ticketIdByRef,
  ticketThread,
} from '../src/server/tickets.server.ts'
import { cleanupDraftSessions } from '../src/server/archive.server.ts'
import { ModelRiverError } from '../src/server/modelriver.server.ts'
import { buildDraftMessages, cleanDraft, composeReplyEmail, composeTicketConfirmation, newTicketRef, normalizeTicketRef, subjectFrom, textFromModel, ticketThreadHeaders } from '../src/lib/ticket-core.ts'
import type { Chunk } from '../src/lib/content-core.ts'

function setup() {
  const db = openDb(':memory:')
  const add = db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, 'x', 'agent', 'now')")
  add.run('sam', 'sam@acme.test', 'Sam')
  add.run('maya', 'maya@acme.test', 'Maya')
  return db
}
const sam = { id: 'sam', name: 'Sam' }

test('a ticket starts open, numbered, with the customer’s message as its first event', () => {
  const db = setup()
  const { id, ref } = createTicket(db, { visitorName: 'Jo', email: 'jo@example.test', text: 'My invoice shows the wrong company name.\nCan you fix it?', source: 'chat' })
  // People see a random code, never the row number.
  assert.match(ref, /^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{6}$/)
  assert.equal(ticketIdByRef(ref, db), id)
  assert.equal(ticketIdByRef('AAAAAA', db), null)
  const t = getTicket(id, db)!
  assert.equal(t.status, 'open')
  assert.equal(t.subject, 'My invoice shows the wrong company name. Can you fix it?')
  assert.deepEqual(t.events.map((e) => [e.kind, e.authorName]), [['message', 'Jo']])
  assert.equal(openTicketCount(db), 1)
})

test('replies, notes, status and assignee changes are all kept in order', () => {
  const db = setup()
  const { id } = createTicket(db, { visitorName: 'Jo', email: 'jo@example.test', text: 'Help', source: 'chat' })
  addNote(id, 'Check Stripe first.', sam, db)
  recordReply(id, 'Fixed it for you.', sam, { status: 'sent' }, 'pending', db)
  const t = getTicket(id, db)!
  // A reply when nobody had it makes it the replier's; a sent reply waits on the customer.
  assert.equal(t.assignee?.id, 'sam')
  assert.equal(t.status, 'pending')
  assert.deepEqual(
    t.events.map((e) => [e.kind, e.body]),
    [
      ['message', 'Help'],
      ['note', 'Check Stripe first.'],
      ['reply', 'Fixed it for you.'],
      ['assign', 'Sam'],
      ['status', 'pending'],
    ],
  )
  // Setting what it already is records nothing.
  setTicketStatus(id, 'pending', sam, db)
  assignTicket(id, 'sam', sam, db)
  assert.equal(getTicket(id, db)!.events.length, 5)
  setTicketStatus(id, 'solved', sam, db)
  assert.ok(getTicket(id, db)!.solvedAt)
  setTicketStatus(id, 'open', sam, db)
  assert.equal(getTicket(id, db)!.solvedAt, null)
})

test('a reply whose email failed is kept, leaves the status alone, and can be sent again', () => {
  const db = setup()
  const { id } = createTicket(db, { visitorName: 'Jo', email: 'jo@example.test', text: 'Help', source: 'chat' })
  recordReply(id, 'Here you go.', sam, { status: 'failed', error: 'Resend refused the email (422)' }, 'pending', db)
  let t = getTicket(id, db)!
  assert.equal(t.status, 'open')
  const failed = t.events.find((e) => e.kind === 'reply')!
  assert.equal(failed.emailStatus, 'failed')
  assert.match(failed.emailError!, /422/)
  // Failed replies aren't part of what an AI draft sees.
  assert.deepEqual(ticketThread(id, db).turns.map((x) => x.from), ['customer'])
  replySentAgain(failed.id, sam, 'pending', db)
  t = getTicket(id, db)!
  assert.equal(t.status, 'pending')
  assert.equal(t.events.find((e) => e.kind === 'reply')!.emailStatus, 'sent')
  assert.throws(() => failedReply(failed.id, db), /already sent/)
})

test('views, assignee filters, counts and pages', () => {
  const db = setup()
  for (let i = 1; i <= 30; i++) createTicket(db, { visitorName: `V${i}`, email: null, text: `Question ${i}`, source: 'chat' })
  assignTicket(1, 'sam', sam, db)
  assignTicket(2, 'maya', sam, db)
  setTicketStatus(3, 'solved', sam, db)
  assert.deepEqual(ticketCounts({}, db), { open: 29, pending: 0, solved: 1 })
  assert.deepEqual(ticketCounts({ assignee: 'mine', userId: 'sam' }, db), { open: 1, pending: 0, solved: 0 })
  assert.equal(ticketCounts({ assignee: 'unassigned' }, db).open, 27)
  const first = listTickets({ view: 'open', limit: 25, offset: 0 }, db)
  assert.equal(first.total, 29)
  assert.equal(first.tickets.length, 25)
  // Open: oldest first, with the latest message as the preview.
  assert.equal(first.tickets[0]!.id, 1)
  assert.equal(first.tickets[0]!.preview, 'Question 1')
  assert.equal(listTickets({ view: 'open', limit: 25, offset: 25 }, db).tickets.length, 4)
})

test('solved tickets are deleted 90 days after they were solved, with their history', () => {
  const db = setup()
  const { id } = createTicket(db, { visitorName: 'Jo', email: null, text: 'Help', source: 'chat' })
  createTicket(db, { visitorName: 'Al', email: null, text: 'Still open', source: 'chat' })
  setTicketStatus(id, 'solved', sam, db)
  assert.equal(pruneTickets(Date.now() + 89 * 86_400_000, db), 0)
  assert.equal(pruneTickets(Date.now() + 91 * 86_400_000, db), 1)
  assert.equal(getTicket(id, db), null)
  assert.equal((db.prepare('SELECT count(*) AS n FROM ticket_events WHERE ticket_id = ?').get(id) as { n: number }).n, 0)
  assert.equal(openTicketCount(db), 1)
})

test('draft sessions stay out of the inbox until deleted; one already gone counts as deleted', async () => {
  const db = setup()
  rememberDraftSession('s-ok', db)
  rememberDraftSession('s-gone', db)
  rememberDraftSession('s-down', db)
  const deleted: string[] = []
  const n = await cleanupDraftSessions(async (id) => {
    if (id === 's-gone') throw new ModelRiverError('Session not found', 404)
    if (id === 's-down') throw new ModelRiverError('Unavailable', 503)
    deleted.push(id)
  }, db)
  assert.equal(n, 2)
  assert.deepEqual(deleted, ['s-ok'])
  assert.deepEqual([...draftSessions(db)], ['s-down'])
  forgetDraftSession('s-down', db)
  assert.equal(draftSessions(db).size, 0)
})

test('messages left before tickets existed become tickets; handled ones are solved', () => {
  const conn = new DatabaseSync(':memory:')
  conn.exec('PRAGMA foreign_keys = ON;')
  // Up to v21, the last version with visitor_messages.
  for (const sql of MIGRATIONS.slice(0, 21)) conn.exec(sql)
  conn.exec('PRAGMA user_version = 21')
  const ins = conn.prepare(
    'INSERT INTO visitor_messages (id, visitor_name, email, email_verified, text, created_at, handled_at, handled_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  )
  ins.run('m1', 'Jo', 'jo@example.test', 1, 'Please call me back', '2026-10-01T10:00:00.000Z', null, null)
  ins.run('m2', 'Al', null, 0, 'Sorted, thanks', '2026-10-02T10:00:00.000Z', '2026-10-03T10:00:00.000Z', 'Sam')
  migrate(conn)
  const one = getTicket(1, conn)!
  // Tickets from before references get one too.
  assert.match(one.ref, /^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{6}$/)
  assert.notEqual(one.ref, getTicket(2, conn)!.ref)
  assert.deepEqual([one.visitorName, one.email, one.emailVerified, one.status, one.subject], ['Jo', 'jo@example.test', true, 'open', 'Please call me back'])
  const two = getTicket(2, conn)!
  assert.equal(two.status, 'solved')
  assert.deepEqual(two.events.map((e) => [e.kind, e.authorName]), [['message', 'Al'], ['status', 'Sam']])
  assert.equal((conn.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'visitor_messages'").get() as { n: number }).n, 0)
})

test('a subject is the first line, cut at a word', () => {
  assert.equal(subjectFrom('  Where is   my order?  '), 'Where is my order?')
  assert.equal(subjectFrom(''), 'Message from the chat')
  const long = subjectFrom('word '.repeat(40))
  assert.ok(long.length <= 81)
  assert.match(long, /word…$/)
})

test('the reply email is escaped, links its URLs, signs off and quotes the original', () => {
  const email = composeReplyEmail({
    ticketRef: 'K7F3Q9',
    subject: 'Invoice name',
    body: 'Hi Jo,\n\nSee https://help.acme.test/articles/billing/invoices. <b>Done</b>',
    agentName: 'Sam',
    brand: 'Acme',
    original: 'My invoice is wrong',
  })
  assert.equal(email.subject, 'Re: Invoice name [#K7F3Q9]')
  assert.match(email.text, /— Sam, Acme/)
  assert.match(email.text, /> My invoice is wrong/)
  assert.match(email.html, /<a href="https:\/\/help\.acme\.test\/articles\/billing\/invoices"/)
  // The trailing full stop isn't part of the link.
  assert.doesNotMatch(email.html, /invoices\."/)
  assert.match(email.html, /&lt;b&gt;Done&lt;\/b&gt;/)
})

test('an AI draft sees the articles and the conversation, never internal notes', () => {
  const chunks: Chunk[] = [
    { slug: 'invoices', path: 'billing/invoices', visibility: 'public', title: 'Invoices', heading: 'Company name', text: 'Change it under Billing.' },
    { slug: 'playbook', path: 'playbook', visibility: 'private', title: 'Playbook', heading: 'Refunds', text: 'Refund within 14 days.' },
  ]
  const [system, user] = buildDraftMessages({
    chunks,
    turns: [
      { from: 'customer', name: 'Jo', body: 'My invoice is wrong' },
      { from: 'team', name: 'Sam', body: 'Which invoice?' },
    ],
    customerName: 'Jo',
    siteUrl: 'https://help.acme.test',
  })
  assert.match(system!.content, /Invoices > Company name \(https:\/\/help\.acme\.test\/articles\/billing\/invoices\)/)
  assert.match(system!.content, /INTERNAL NOTE \(use it, but never quote or mention it\): Refunds/)
  assert.match(system!.content, /never offer to connect them with the team/)
  assert.match(user!.content, /Customer \(Jo\):\nMy invoice is wrong/)
  assert.match(user!.content, /Our reply \(Sam\):\nWhich invoice\?/)
  // Without APP_URL there are no links to give.
  assert.doesNotMatch(buildDraftMessages({ chunks, turns: [], customerName: 'Jo', siteUrl: null })[0]!.content, /https:/)
})

test('the draft’s text is read from the shapes ModelRiver returns', () => {
  assert.equal(textFromModel('plain'), 'plain')
  assert.equal(textFromModel({ content: 'a' }), 'a')
  assert.equal(textFromModel({ choices: [{ message: { content: 'b' } }] }), 'b')
  assert.equal(textFromModel({ message: { content: 'c' } }), 'c')
  assert.equal(textFromModel(null), '')
})

test('references are six unambiguous characters, all equally likely, and typed loosely', () => {
  const seen = new Set<string>()
  for (let i = 0; i < 2000; i++) seen.add(newTicketRef())
  assert.equal(seen.size, 2000)
  for (const ref of seen) assert.match(ref, /^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{6}$/)
  // Bytes of 240 and up are skipped rather than wrapped, so no character is favoured.
  let calls = 0
  const ref = newTicketRef((n) => (calls++ === 0 ? new Uint8Array(n).fill(250) : new Uint8Array(n).fill(31)))
  assert.equal(ref, 'BBBBBB')
  assert.equal(normalizeTicketRef(' #k7f3q9 '), 'K7F3Q9')
  assert.equal(normalizeTicketRef('K7F3Q0'), null, 'no zero')
  assert.equal(normalizeTicketRef('12'), null)
})

test('the chat’s hidden markers are taken out of a draft', () => {
  assert.equal(
    cleanDraft('Hi James,\n\nYou can export it under Settings [[exporting-your-data]].\n\nWant me to connect you with the team?\n\n[[unsure]]'),
    'Hi James,\n\nYou can export it under Settings.\n\nWant me to connect you with the team?',
  )
  assert.equal(cleanDraft('Passing you on. [[handoff]]'), 'Passing you on.')
  // Ordinary square brackets stay: [add details] is for the team to fill in.
  assert.equal(cleanDraft('Your plan is [add details].'), 'Your plan is [add details].')
})

test('a ticket’s emails share one thread, rooted at the sender’s domain', () => {
  assert.deepEqual(ticketThreadHeaders('K7F3Q9', 'Acme Support <help@Acme.com>'), {
    'In-Reply-To': '<ticket-k7f3q9@acme.com>',
    References: '<ticket-k7f3q9@acme.com>',
  })
  assert.equal(ticketThreadHeaders('K7F3Q9', 'help@acme.com').References, '<ticket-k7f3q9@acme.com>')
  // No sender set (the log provider): still a valid message id.
  assert.equal(ticketThreadHeaders('K7F3Q9', '').References, '<ticket-k7f3q9@desk.invalid>')
})

test('the confirmation email gives the reference and the portal link, and threads with the replies', () => {
  const email = composeTicketConfirmation({
    ticketRef: 'K7F3Q9',
    subject: 'Charged twice',
    brand: 'Acme',
    message: 'I was charged <b>twice</b>.',
    link: 'https://help.acme.com/customer-portal/tickets/K7F3Q9?k=abc',
  })
  assert.equal(email.subject, 'Charged twice [#K7F3Q9]')
  // A reply's subject is the same with "Re:", so mail apps keep them together.
  assert.equal(composeReplyEmail({ ticketRef: 'K7F3Q9', subject: 'Charged twice', body: 'x', agentName: 'Sam', brand: 'Acme', original: null }).subject, `Re: ${email.subject}`)
  assert.match(email.text, /Your ticket is #K7F3Q9/)
  assert.match(email.text, /See it and add details: https:\/\/help\.acme\.com\/customer-portal\/tickets\/K7F3Q9\?k=abc/)
  assert.match(email.text, /> I was charged <b>twice<\/b>\./)
  assert.match(email.html, /View your ticket/)
  assert.match(email.html, /&lt;b&gt;twice/)
  assert.doesNotMatch(email.html, /<b>twice/)
  assert.doesNotMatch(composeTicketConfirmation({ ticketRef: 'K7F3Q9', subject: 'x', brand: 'Acme', message: 'x', link: null }).text, /See it/)
})
