import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/server/db.server.ts'
import { cancelScheduledDrain, drainOutbox, MAX_ATTEMPTS, queuedReplies, queueEmail, takeQueuedReply } from '../src/server/outbox.server.ts'
import { createTicket, getTicket, recordReply } from '../src/server/tickets.server.ts'
import type { Email } from '../src/server/email.server.ts'

after(cancelScheduledDrain)

const MINUTE = 60_000
const email = (to: string): Email => ({ to, subject: 'Hi', text: 'Hi', html: '<p>Hi</p>' })
const ok = async () => {}
const down = async () => {
  throw new Error('provider down')
}
const rows = (db: ReturnType<typeof openDb>) =>
  db.prepare('SELECT kind, attempts, next_attempt_at, last_error FROM email_outbox').all().map((r) => ({ ...r })) as Array<{
    kind: string
    attempts: number
    next_attempt_at: string
    last_error: string | null
  }>

test('a queued email waits, is retried with a growing wait, and is gone once sent', async () => {
  const db = openDb(':memory:')
  const t0 = Date.parse('2026-10-31T10:00:00.000Z')
  queueEmail(email('a@example.test'), { kind: 'notification', error: 'first try failed' }, db, t0)
  assert.equal(rows(db)[0]!.next_attempt_at, '2026-10-31T10:01:00.000Z')

  // Not due yet: nothing is sent.
  const sent: string[] = []
  assert.deepEqual(await drainOutbox(db, async (e) => void sent.push(e.to), t0 + 30_000), { sent: 0, failed: 0 })

  // Due, and the provider is still down: the next try is 5 minutes later.
  assert.deepEqual(await drainOutbox(db, down, t0 + MINUTE), { sent: 0, failed: 1 })
  assert.deepEqual(rows(db), [{ kind: 'notification', attempts: 2, next_attempt_at: '2026-10-31T10:06:00.000Z', last_error: 'provider down' }])

  assert.deepEqual(await drainOutbox(db, async (e) => void sent.push(e.to), t0 + 6 * MINUTE), { sent: 1, failed: 0 })
  assert.deepEqual(sent, ['a@example.test'])
  assert.deepEqual(rows(db), [])
})

test('an email is given up after the last try', async () => {
  const db = openDb(':memory:')
  let t = Date.parse('2026-10-31T10:00:00.000Z')
  queueEmail(email('a@example.test'), { kind: 'confirmation', error: 'x' }, db, t)
  for (let i = 1; i < MAX_ATTEMPTS; i++) {
    t = Date.parse(rows(db)[0]!.next_attempt_at)
    await drainOutbox(db, down, t)
  }
  assert.deepEqual(rows(db), [])
})

test('a reply sent by a retry is marked sent, and the ticket takes the status its author chose', async () => {
  const db = openDb(':memory:')
  db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('sam', 'sam@acme.test', 'Sam', 'x', 'agent', 'now')").run()
  const { id } = createTicket(db, { visitorName: 'Jo', email: 'jo@example.test', text: 'Charged twice', source: 'chat' })
  const eventId = recordReply(id, 'Refunded.', { id: 'sam', name: 'Sam' }, { status: 'failed', error: 'provider down' }, 'solved', db)
  const t0 = Date.now()
  queueEmail(email('jo@example.test'), { kind: 'reply', error: 'provider down', ticketEventId: eventId, thenStatus: 'solved' }, db, t0)
  assert.deepEqual([...queuedReplies([eventId], db).keys()], [eventId])
  assert.equal(getTicket(id, db)!.status, 'open', 'not sent yet')

  await drainOutbox(db, down, t0 + MINUTE)
  assert.equal(getTicket(id, db)!.events.find((e) => e.id === eventId)!.emailError, 'provider down')

  await drainOutbox(db, ok, t0 + 6 * MINUTE)
  const ticket = getTicket(id, db)!
  assert.equal(ticket.events.find((e) => e.id === eventId)!.emailStatus, 'sent')
  assert.equal(ticket.status, 'solved')
  assert.equal(ticket.events.at(-1)!.authorName, 'Sam', 'in the name of whoever wrote the reply')
  assert.equal(queuedReplies([eventId], db).size, 0)
})

test('sending a reply by hand takes its queued retry out first, so it never goes twice', () => {
  const db = openDb(':memory:')
  db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('sam', 'sam@acme.test', 'Sam', 'x', 'agent', 'now')").run()
  const { id } = createTicket(db, { visitorName: 'Jo', email: 'jo@example.test', text: 'Hi', source: 'chat' })
  const eventId = recordReply(id, 'Hello', { id: 'sam', name: 'Sam' }, { status: 'failed', error: 'x' }, 'pending', db)
  queueEmail(email('jo@example.test'), { kind: 'reply', error: 'x', ticketEventId: eventId, thenStatus: 'pending' }, db)
  assert.equal(takeQueuedReply(eventId, db), 'pending')
  assert.equal(takeQueuedReply(eventId, db), null)
  assert.deepEqual(rows(db), [])
})
