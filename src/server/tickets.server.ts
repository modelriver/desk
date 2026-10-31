import type { DatabaseSync } from 'node:sqlite'
import { getDb, now } from './db.server.ts'
import { avatarsByUser } from './avatars.server.ts'
import { newTicketRef, subjectFrom, type TicketStatus } from '../lib/ticket-core.ts'

// Tickets: requests the team answers by email, on their own time. They come
// from the chat (a visitor leaves a message while "Talk with a person" is off,
// or the team turns a chat into one) or are opened by a team member. Each has
// a random reference (#K7F3Q9) and keeps a history of events: the customer's message,
// replies (sent by email), internal notes, and status and assignee changes.
// Solved tickets are deleted RETENTION_DAYS after they were solved.

const RETENTION_DAYS = 90
const DAY = 24 * 60 * 60_000

// Where it came from: the chat, the team, or the customer portal.
export type TicketSource = 'chat' | 'team' | 'portal'
type Who = { id: string | null; name: string }

export interface TicketSummary {
  id: number
  // What people see and say: #K7F3Q9.
  ref: string
  subject: string
  status: TicketStatus
  visitorName: string
  email: string | null
  emailVerified: boolean
  assignee: { id: string; name: string } | null
  source: TicketSource
  createdAt: string
  updatedAt: string
  // The latest message or reply, for the list.
  preview: string
}

export interface TicketEvent {
  id: number
  kind: 'message' | 'reply' | 'note' | 'status' | 'assign'
  authorId: string | null
  authorName: string | null
  body: string
  emailStatus: 'sent' | 'failed' | null
  emailError: string | null
  createdAt: string
}

export interface TicketDetail extends Omit<TicketSummary, 'preview'> {
  // The chat it came from, while that still exists in Desk.
  sessionId: string | null
  createdBy: string | null
  solvedAt: string | null
  events: TicketEvent[]
}

type Row = {
  id: number
  ref: string
  origin: TicketSource | null
  conversation_id: string | null
  session_id: string | null
  visitor_name: string
  email: string | null
  email_verified: number
  subject: string
  status: TicketStatus
  assignee_id: string | null
  assignee_name: string | null
  source: TicketSource
  created_by: string | null
  created_at: string
  updated_at: string
  solved_at: string | null
}

const SELECT = `SELECT t.*, u.name AS assignee_name FROM tickets t LEFT JOIN users u ON u.id = t.assignee_id`

export function createTicket(
  db: DatabaseSync,
  input: {
    conversationId?: string | null
    sessionId?: string | null
    visitorName: string
    email: string | null
    emailVerified?: boolean
    subject?: string | null
    text: string
    source: TicketSource
    createdBy?: string | null
  },
): { id: number; ref: string } {
  const ts = now()
  const subject = input.subject?.trim() || subjectFrom(input.text)
  const insert = db.prepare(
    `INSERT INTO tickets (ref, conversation_id, session_id, visitor_name, email, email_verified, subject, status, source, origin, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
  )
  // A fresh code, tried again in the very unlikely case it's taken.
  for (let attempt = 0; ; attempt++) {
    const ref = newTicketRef()
    try {
      const res = insert.run(
        ref,
        input.conversationId ?? null,
        input.sessionId ?? null,
        input.visitorName,
        input.email,
        input.emailVerified ? 1 : 0,
        subject,
        input.source === 'team' ? 'team' : 'chat',
        input.source,
        input.createdBy ?? null,
        ts,
        ts,
      )
      const id = Number(res.lastInsertRowid)
      addEvent(db, id, { kind: 'message', author: { id: null, name: input.visitorName }, body: input.text, at: ts })
      return { id, ref }
    } catch (err) {
      if (attempt >= 5 || !String((err as Error).message).includes('tickets.ref')) throw err
    }
  }
}

function addEvent(
  db: DatabaseSync,
  ticketId: number,
  e: { kind: TicketEvent['kind']; author: Who; body?: string; emailStatus?: 'sent' | 'failed' | null; emailError?: string | null; at?: string },
): number {
  const r = db.prepare(
    `INSERT INTO ticket_events (ticket_id, kind, author_id, author_name, body, email_status, email_error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(ticketId, e.kind, e.author.id, e.author.name, e.body ?? '', e.emailStatus ?? null, e.emailError ?? null, e.at ?? now())
  return Number(r.lastInsertRowid)
}

export type TicketView = 'open' | 'pending' | 'solved'
export type AssigneeFilter = 'all' | 'mine' | 'unassigned'

// One page of a view. Open: oldest first (who's waited longest). Waiting on
// the customer: most recently updated first. Solved: most recently solved first.
export function listTickets(
  input: { view: TicketView; assignee?: AssigneeFilter; userId?: string; limit?: number; offset?: number },
  db: DatabaseSync = getDb(),
): { tickets: TicketSummary[]; total: number } {
  const { where, args } = filter(input)
  const order = input.view === 'open' ? 't.created_at ASC' : input.view === 'pending' ? 't.updated_at DESC' : 't.solved_at DESC'
  const total = (db.prepare(`SELECT count(*) AS n FROM tickets t WHERE ${where}`).get(...args) as { n: number }).n
  const rows = db
    .prepare(`${SELECT} WHERE ${where} ORDER BY ${order}, t.id LIMIT ? OFFSET ?`)
    .all(...args, input.limit ?? 25, input.offset ?? 0) as Row[]
  const previews = latestText(db, rows.map((r) => r.id))
  return { tickets: rows.map((r) => ({ ...summary(r), preview: previews.get(r.id) ?? '' })), total }
}

// How many tickets each view holds, for the tabs' counts (with the same assignee filter).
export function ticketCounts(input: { assignee?: AssigneeFilter; userId?: string }, db: DatabaseSync = getDb()): Record<TicketView, number> {
  const counts: Record<TicketView, number> = { open: 0, pending: 0, solved: 0 }
  for (const view of ['open', 'pending', 'solved'] as const) {
    const { where, args } = filter({ ...input, view })
    counts[view] = (db.prepare(`SELECT count(*) AS n FROM tickets t WHERE ${where}`).get(...args) as { n: number }).n
  }
  return counts
}

export function openTicketCount(db: DatabaseSync = getDb()): number {
  return (db.prepare("SELECT count(*) AS n FROM tickets WHERE status = 'open'").get() as { n: number }).n
}

function filter(input: { view: TicketView; assignee?: AssigneeFilter; userId?: string }): { where: string; args: Array<string> } {
  const clauses = ['t.status = ?']
  const args: string[] = [input.view]
  if (input.assignee === 'mine' && input.userId) {
    clauses.push('t.assignee_id = ?')
    args.push(input.userId)
  } else if (input.assignee === 'unassigned') {
    clauses.push('t.assignee_id IS NULL')
  }
  return { where: clauses.join(' AND '), args }
}

// The newest message or reply on each ticket, flattened for a one-line preview.
function latestText(db: DatabaseSync, ids: number[]): Map<number, string> {
  if (!ids.length) return new Map()
  const rows = db
    .prepare(
      `SELECT e.ticket_id, e.body FROM ticket_events e
       WHERE e.id IN (SELECT max(id) FROM ticket_events WHERE kind IN ('message', 'reply') AND ticket_id IN (${ids.map(() => '?').join(',')}) GROUP BY ticket_id)`,
    )
    .all(...ids) as Array<{ ticket_id: number; body: string }>
  return new Map(rows.map((r) => [r.ticket_id, r.body.replace(/\s+/g, ' ').trim().slice(0, 160)]))
}

function summary(r: Row): Omit<TicketSummary, 'preview'> {
  return {
    id: r.id,
    ref: r.ref,
    subject: r.subject,
    status: r.status,
    visitorName: r.visitor_name,
    email: r.email,
    emailVerified: r.email_verified === 1,
    assignee: r.assignee_id ? { id: r.assignee_id, name: r.assignee_name ?? 'Someone' } : null,
    source: r.origin ?? r.source,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export function getTicket(id: number, db: DatabaseSync = getDb()): TicketDetail | null {
  const r = db.prepare(`${SELECT} WHERE t.id = ?`).get(id) as Row | undefined
  if (!r) return null
  const events = db.prepare('SELECT * FROM ticket_events WHERE ticket_id = ? ORDER BY id').all(id) as Array<{
    id: number
    kind: TicketEvent['kind']
    author_id: string | null
    author_name: string | null
    body: string
    email_status: 'sent' | 'failed' | null
    email_error: string | null
    created_at: string
  }>
  return {
    ...summary(r),
    sessionId: r.conversation_id ? r.session_id : null,
    createdBy: r.created_by,
    solvedAt: r.solved_at,
    events: events.map((e) => ({
      id: e.id,
      kind: e.kind,
      authorId: e.author_id,
      authorName: e.author_name,
      body: e.body,
      emailStatus: e.email_status,
      emailError: e.email_error,
      createdAt: e.created_at,
    })),
  }
}

// The ticket a reference names (#K7F3Q9), for the dashboard's links.
export function ticketIdByRef(ref: string, db: DatabaseSync = getDb()): number | null {
  const row = db.prepare('SELECT id FROM tickets WHERE ref = ?').get(ref) as { id: number } | undefined
  return row?.id ?? null
}

export class TicketError extends Error {}

function requireTicket(db: DatabaseSync, id: number): Row {
  const r = db.prepare(`${SELECT} WHERE t.id = ?`).get(id) as Row | undefined
  if (!r) throw new TicketError('That ticket no longer exists.')
  return r
}

// A change of status, recorded in the history. Solving stamps when; reopening clears it.
export function setTicketStatus(id: number, status: TicketStatus, by: Who, db: DatabaseSync = getDb()): void {
  const r = requireTicket(db, id)
  if (r.status === status) return
  const ts = now()
  db.prepare('UPDATE tickets SET status = ?, updated_at = ?, solved_at = ? WHERE id = ?').run(status, ts, status === 'solved' ? ts : null, id)
  addEvent(db, id, { kind: 'status', author: by, body: status, at: ts })
}

// Who's handling it (null: nobody), recorded with the new assignee's name.
export function assignTicket(id: number, assigneeId: string | null, by: Who, db: DatabaseSync = getDb()): void {
  const r = requireTicket(db, id)
  if (r.assignee_id === assigneeId) return
  let name = ''
  if (assigneeId) {
    const u = db.prepare('SELECT name FROM users WHERE id = ?').get(assigneeId) as { name: string } | undefined
    if (!u) throw new TicketError('That team member no longer exists.')
    name = u.name
  }
  const ts = now()
  db.prepare('UPDATE tickets SET assignee_id = ?, updated_at = ? WHERE id = ?').run(assigneeId, ts, id)
  addEvent(db, id, { kind: 'assign', author: by, body: name, at: ts })
}

export function addNote(id: number, body: string, by: Who, db: DatabaseSync = getDb()): void {
  requireTicket(db, id)
  const ts = now()
  db.prepare('UPDATE tickets SET updated_at = ? WHERE id = ?').run(ts, id)
  addEvent(db, id, { kind: 'note', author: by, body, at: ts })
}

// A reply, after the email went out (or failed: it's kept, marked failed, so
// the text isn't lost and can be sent again). A reply from someone when nobody
// has the ticket makes it theirs. `then` is the status afterwards: waiting on
// the customer by default.
export function recordReply(
  id: number,
  body: string,
  by: { id: string; name: string },
  email: { status: 'sent' | 'failed'; error?: string | null },
  then: TicketStatus,
  db: DatabaseSync = getDb(),
): number {
  const r = requireTicket(db, id)
  const ts = now()
  const eventId = addEvent(db, id, { kind: 'reply', author: by, body, emailStatus: email.status, emailError: email.error ?? null, at: ts })
  db.prepare('UPDATE tickets SET updated_at = ? WHERE id = ?').run(ts, id)
  if (!r.assignee_id) assignTicket(id, by.id, by, db)
  if (email.status === 'sent') setTicketStatus(id, then, by, db)
  return eventId
}

// A reply whose email failed, for sending again: its ticket, text and author.
export function failedReply(eventId: number, db: DatabaseSync = getDb()) {
  const e = db
    .prepare("SELECT ticket_id, body, author_name FROM ticket_events WHERE id = ? AND kind = 'reply' AND email_status = 'failed'")
    .get(eventId) as { ticket_id: number; body: string; author_name: string | null } | undefined
  if (!e) throw new TicketError('That reply was already sent, or no longer exists.')
  return { ticketId: e.ticket_id, body: e.body, authorName: e.author_name ?? 'Support' }
}

// Sent on a second try: marked sent, and the ticket waits on the customer as usual.
export function replySentAgain(eventId: number, by: Who, then: TicketStatus, db: DatabaseSync = getDb()) {
  const { ticketId } = failedReply(eventId, db)
  db.prepare("UPDATE ticket_events SET email_status = 'sent', email_error = NULL WHERE id = ?").run(eventId)
  setTicketStatus(ticketId, then, by, db)
}

// Sent by an automatic retry (see outbox.server.ts): marked sent, and the
// ticket takes the status its author chose, in their name.
export function replySentByRetry(eventId: number, then: TicketStatus, db: DatabaseSync = getDb()) {
  const e = db
    .prepare("UPDATE ticket_events SET email_status = 'sent', email_error = NULL WHERE id = ? AND email_status = 'failed' RETURNING ticket_id, author_id, author_name")
    .get(eventId) as { ticket_id: number; author_id: string | null; author_name: string | null } | undefined
  if (e) setTicketStatus(e.ticket_id, then, { id: e.author_id, name: e.author_name ?? 'Support' }, db)
}

export function replyFailedAgain(eventId: number, error: string, db: DatabaseSync = getDb()) {
  db.prepare('UPDATE ticket_events SET email_error = ? WHERE id = ?').run(error, eventId)
}

export function deleteTicket(id: number, db: DatabaseSync = getDb()): boolean {
  return Number(db.prepare('DELETE FROM tickets WHERE id = ?').run(id).changes) > 0
}

// For an AI draft: the customer's message and the replies so far, never the notes.
export function ticketThread(id: number, db: DatabaseSync = getDb()) {
  const t = getTicket(id, db)
  if (!t) throw new TicketError('That ticket no longer exists.')
  return {
    ticket: t,
    turns: t.events
      .filter((e) => e.kind === 'message' || (e.kind === 'reply' && e.emailStatus === 'sent'))
      .map((e) => ({ from: e.kind === 'message' ? ('customer' as const) : ('team' as const), name: e.authorName ?? '', body: e.body })),
  }
}

// Hourly cleanup: tickets solved more than RETENTION_DAYS ago.
export function pruneTickets(at = Date.now(), db: DatabaseSync = getDb()): number {
  const cutoff = new Date(at - RETENTION_DAYS * DAY).toISOString()
  return Number(db.prepare("DELETE FROM tickets WHERE status = 'solved' AND solved_at < ?").run(cutoff).changes)
}

// --- The customer's side (/tickets/<ref>, see ticket-access.server.ts) ---

export interface CustomerTicket {
  id: number
  ref: string
  subject: string
  status: TicketStatus
  visitorName: string
  // Who may open it: only someone signed in as this address.
  email: string | null
  createdAt: string
  // Their messages and the team's sent replies. Never internal notes, failed
  // emails, or who it's assigned to.
  // A reply's `avatar` is its sender's profile picture (/avatars/…), when they've set one.
  thread: Array<{ id: number; from: 'customer' | 'team'; name: string; avatar: string | null; body: string; at: string }>
}

export function customerTicket(ref: string, db: DatabaseSync = getDb()): CustomerTicket | null {
  const id = ticketIdByRef(ref, db)
  const t = id === null ? null : getTicket(id, db)
  if (!t) return null
  const thread = t.events.filter((e) => e.kind === 'message' || (e.kind === 'reply' && e.emailStatus === 'sent'))
  const avatars = avatarsByUser(thread.flatMap((e) => (e.kind === 'reply' && e.authorId ? [e.authorId] : [])), db)
  return {
    id: t.id,
    ref: t.ref,
    subject: t.subject,
    status: t.status,
    visitorName: t.visitorName,
    email: t.email,
    createdAt: t.createdAt,
    thread: thread.map((e) => ({
      id: e.id,
      from: e.kind === 'message' ? ('customer' as const) : ('team' as const),
      name: e.kind === 'message' ? t.visitorName : (e.authorName ?? 'Our team'),
      avatar: e.kind === 'reply' && e.authorId ? (avatars.get(e.authorId) ?? null) : null,
      body: e.body,
      at: e.createdAt,
    })),
  }
}

// The customer answered on the ticket page: it's theirs again to look at, so
// a ticket waiting on them (or solved) opens again.
export function addCustomerMessage(id: number, text: string, db: DatabaseSync = getDb()): void {
  const r = requireTicket(db, id)
  const ts = now()
  addEvent(db, id, { kind: 'message', author: { id: null, name: r.visitor_name }, body: text, at: ts })
  db.prepare('UPDATE tickets SET updated_at = ? WHERE id = ?').run(ts, id)
  if (r.status !== 'open') setTicketStatus(id, 'open', { id: null, name: r.visitor_name }, db)
}

// The tickets raised with an address, newest activity first, for its portal.
export function ticketsForEmail(email: string, db: DatabaseSync = getDb()) {
  return (
    db
      .prepare('SELECT ref, subject, status, created_at, updated_at FROM tickets WHERE email = ? ORDER BY updated_at DESC LIMIT 100')
      .all(email) as Array<{ ref: string; subject: string; status: TicketStatus; created_at: string; updated_at: string }>
  ).map((r) => ({ ref: r.ref, subject: r.subject, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at }))
}

// --- AI drafts' sessions ---
// Desk's workflow keeps session memory, so every request starts a ModelRiver
// session. A draft's is deleted right after; until then (or if deleting
// fails) it's listed here so the inbox leaves it out.

export function rememberDraftSession(sessionId: string, db: DatabaseSync = getDb()) {
  db.prepare('INSERT OR IGNORE INTO draft_sessions (session_id, created_at) VALUES (?, ?)').run(sessionId, now())
}

export function forgetDraftSession(sessionId: string, db: DatabaseSync = getDb()) {
  db.prepare('DELETE FROM draft_sessions WHERE session_id = ?').run(sessionId)
}

export function draftSessions(db: DatabaseSync = getDb()): Set<string> {
  return new Set((db.prepare('SELECT session_id FROM draft_sessions').all() as Array<{ session_id: string }>).map((r) => r.session_id))
}
