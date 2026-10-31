import { test } from 'node:test'
import assert from 'node:assert/strict'
import { signAwsRequest } from '../src/server/aws-sigv4.server.ts'
import { composeNotification, recipientsFor, type NotificationEvent } from '../src/server/notifications.server.ts'
import { DatabaseSync } from 'node:sqlite'
import { migrate, MIGRATIONS, openDb } from '../src/server/db.server.ts'
import { createTicket } from '../src/server/tickets.server.ts'
import { markHandoff } from '../src/server/conversation-state.server.ts'

test('SigV4 signing matches the example in the AWS documentation', () => {
  const headers = signAwsRequest({
    method: 'GET',
    url: 'https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08',
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
    body: '',
    region: 'us-east-1',
    service: 'iam',
    credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' },
    now: new Date('2015-08-30T12:36:00Z'),
  })
  assert.equal(
    headers.Authorization,
    'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7',
  )
  assert.equal(headers['x-amz-date'], '20150830T123600Z')
})

const at = '2026-10-26T10:00:00.000Z'
const waiting: NotificationEvent = { kind: 'handoff', reason: 'asked', visitorName: 'Jack', sessionId: 'abc', text: 'Can I talk to someone?', at }
const failed: NotificationEvent = { kind: 'handoff', reason: 'ai_error', visitorName: 'Rita', sessionId: 'def', text: null, at }
const started: NotificationEvent = { kind: 'new_conversation', visitorName: 'Sam', sessionId: 'ghi', text: 'How do I export?', at }
const left: NotificationEvent = { kind: 'ticket', ticketRef: 'K7F3Q9', visitorName: 'Jo', sessionId: 'jkl', text: 'Please email me about my invoice.', at }

test('one event gets a specific subject and a link to the conversation', () => {
  const email = composeNotification([waiting], { brand: 'Acme', appUrl: 'https://support.acme.com' })
  assert.equal(email.subject, 'Jack wants to talk to a person')
  assert.match(email.text, /“Can I talk to someone\?”/)
  assert.match(email.text, /https:\/\/support\.acme\.com\/dashboard\/c\/abc/)
  assert.match(email.text, /dashboard\/account/)
  assert.equal(composeNotification([failed], { brand: 'Acme', appUrl: '' }).subject, 'The AI couldn’t answer Rita')
})

test('several events become one email', () => {
  assert.equal(composeNotification([waiting, failed], { brand: 'Acme', appUrl: '' }).subject, '2 people are waiting for the team')
  const mixed = composeNotification([waiting, started], { brand: 'Acme', appUrl: '' })
  assert.equal(mixed.subject, '2 updates from Acme')
  assert.doesNotMatch(mixed.text, /Open:/, 'no links without APP_URL')
})

test('visitor text is escaped in the HTML version', () => {
  const html = composeNotification([{ ...waiting, visitorName: '<b>x</b>', text: '<script>alert(1)</script>' }], { brand: 'Acme', appUrl: '' }).html
  assert.doesNotMatch(html, /<script>|<b>x/)
  assert.match(html, /&lt;script&gt;/)
})

test('each person only gets the events they turned on', () => {
  const db = openDb(':memory:')
  const add = (id: string, handoff: number, conversations: number) =>
    db
      .prepare(
        "INSERT INTO users (id, email, name, password_hash, role, created_at, notify_handoff, notify_new_conversations) VALUES (?, ?, ?, 'x', 'agent', 'now', ?, ?)",
      )
      .run(id, `${id}@example.test`, id, handoff, conversations)
  add('both', 1, 1)
  add('waiting-only', 1, 0)
  add('none', 0, 0)
  const result = Object.fromEntries(recipientsFor(db, [waiting, started]).map((r) => [r.user.id, r.events.map((e) => e.kind)]))
  assert.deepEqual(result, { both: ['handoff', 'new_conversation'], 'waiting-only': ['handoff'] })
})

test('new team members get "someone wants a person" emails by default, not every conversation', () => {
  const db = openDb(':memory:')
  db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('u', 'u@example.test', 'U', 'x', 'agent', 'now')").run()
  assert.deepEqual(
    { ...(db.prepare('SELECT notify_handoff, notify_new_conversations FROM users').get() as object) },
    { notify_handoff: 1, notify_new_conversations: 0 },
  )
})

test('the team is notified once per wait, not on every message', () => {
  const db = openDb(':memory:')
  db.prepare(
    "INSERT INTO conversations (id, visitor_token_hash, visitor_name, mode, created_at, last_activity_at) VALUES ('c', 'h', 'Jack', 'ai', 'now', 'now')",
  ).run()
  assert.equal(markHandoff(db, 'c', 'asked'), true)
  assert.equal(markHandoff(db, 'c', 'ai_error'), false)
})

test('a new ticket goes to people who follow new tickets, linking to it', () => {
  const db = openDb(':memory:')
  db.prepare(
    "INSERT INTO users (id, email, name, password_hash, role, created_at, notify_handoff, notify_new_tickets) VALUES ('a', 'a@example.test', 'A', 'x', 'agent', 'now', 0, 1), ('b', 'b@example.test', 'B', 'x', 'agent', 'now', 1, 0)",
  ).run()
  assert.deepEqual(recipientsFor(db, [left]).map((r) => r.user.id), ['a'])
  const email = composeNotification([left], { brand: 'Acme', appUrl: 'https://support.acme.com' })
  assert.equal(email.subject, 'Jo raised ticket #K7F3Q9')
  assert.match(email.text, /https:\/\/support\.acme\.com\/dashboard\/tickets\/K7F3Q9/)
  assert.match(email.html, /Open the ticket/)
})

test('activity on a ticket goes to whoever has it; never to the person who did it', () => {
  const db = openDb(':memory:')
  const add = db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at, notify_new_tickets, notify_my_tickets) VALUES (?, ?, ?, 'x', 'agent', 'now', ?, ?)")
  add.run('owner', 'owner@example.test', 'Owner', 0, 1)
  add.run('follower', 'follower@example.test', 'Follower', 1, 1)
  add.run('quiet', 'quiet@example.test', 'Quiet', 0, 0)
  const mine = createTicket(db, { visitorName: 'Jo', email: 'jo@example.test', text: 'Hi', source: 'chat' })
  const nobodys = createTicket(db, { visitorName: 'Al', email: 'al@example.test', text: 'Hi', source: 'chat' })
  db.prepare("UPDATE tickets SET assignee_id = 'owner' WHERE id = ?").run(mine.id)
  const who = (e: NotificationEvent) => recipientsFor(db, [e]).map((r) => r.user.id)

  // The customer replied: the assignee only, or, with nobody on it, the people following new tickets.
  assert.deepEqual(who({ kind: 'ticket_reply', ticketRef: mine.ref, visitorName: 'Jo', sessionId: null, text: 'More', at }), ['owner'])
  assert.deepEqual(who({ kind: 'ticket_reply', ticketRef: nobodys.ref, visitorName: 'Al', sessionId: null, text: 'More', at }), ['follower'])

  // Assigned by someone else: the new assignee. Assigned to yourself: nobody.
  const assigned = (to: string, by: string): NotificationEvent => ({ kind: 'ticket_assigned', ticketRef: mine.ref, assigneeId: to, actor: { id: by, name: by }, visitorName: '', sessionId: null, text: 'Hi', at })
  assert.deepEqual(who(assigned('follower', 'owner')), ['follower'])
  assert.deepEqual(who(assigned('owner', 'owner')), [])
  assert.deepEqual(who(assigned('quiet', 'owner')), [], 'turned off')
  assert.equal(composeNotification([assigned('follower', 'owner')], { brand: 'Acme', appUrl: '' }).subject, `owner assigned you ticket #${mine.ref}`)
})

test('ticket emails: on for your own tickets by default; every new ticket follows "someone wants a person"', () => {
  const db = openDb(':memory:')
  db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('u', 'u@example.test', 'U', 'x', 'agent', 'now')").run()
  assert.deepEqual({ ...(db.prepare('SELECT notify_my_tickets, notify_new_tickets FROM users').get() as object) }, { notify_my_tickets: 1, notify_new_tickets: 0 })
  // Migrating: whoever had "someone wants a person" on (it used to cover tickets) keeps getting them.
  const old = migrateFrom25(db => db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at, notify_handoff) VALUES ('a', 'a@x.test', 'A', 'x', 'agent', 'now', 1), ('b', 'b@x.test', 'B', 'x', 'agent', 'now', 0)").run())
  assert.deepEqual(old.prepare('SELECT id, notify_new_tickets FROM users ORDER BY id').all().map((r) => ({ ...r })), [
    { id: 'a', notify_new_tickets: 1 },
    { id: 'b', notify_new_tickets: 0 },
  ])
})

// A database at schema 25 with `seed` run on it, then migrated to the latest.
function migrateFrom25(seed: (db: DatabaseSync) => void): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  MIGRATIONS.slice(0, 25).forEach((sql) => db.exec(sql))
  db.exec('PRAGMA user_version = 25')
  seed(db)
  migrate(db)
  return db
}
