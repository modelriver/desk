import type { DatabaseSync } from 'node:sqlite'
import { getDb, now } from './db.server.ts'
import { sendEmail, type Email } from './email.server.ts'
import { replyFailedAgain, replySentByRetry } from './tickets.server.ts'
import { errorMessage } from '../lib/errors.ts'
import type { TicketStatus } from '../lib/ticket-core.ts'

// Emails that couldn't be sent (the provider was down, say) are kept here and
// tried again after 1, 5, 15 and 30 minutes, then 1, 2, 4 and 8 hours: about
// 16 hours in all, then given up. Each try is recorded before sending, so a
// crash mid-send delays an email rather than sending it twice. Sign-in codes
// aren't queued: they expire in minutes.

const RETRY_MINUTES = [1, 5, 15, 30, 60, 120, 240, 480]
// The first try happened before the email was queued.
export const MAX_ATTEMPTS = RETRY_MINUTES.length + 1
const BATCH = 20
const MINUTE = 60_000

export type OutboxKind = 'reply' | 'confirmation' | 'notification'

interface Row {
  id: number
  kind: OutboxKind
  message: string
  ticket_event_id: number | null
  then_status: TicketStatus | null
  attempts: number
}

// Queues an email whose first send failed. A ticket reply names its event,
// and the status the ticket takes once it's sent.
export function queueEmail(
  email: Email,
  opts: { kind: OutboxKind; error: string; ticketEventId?: number; thenStatus?: TicketStatus },
  db: DatabaseSync = getDb(),
  nowMs = Date.now(),
): void {
  db.prepare(
    `INSERT INTO email_outbox (kind, message, ticket_event_id, then_status, attempts, next_attempt_at, last_error, created_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
  ).run(opts.kind, JSON.stringify(email), opts.ticketEventId ?? null, opts.thenStatus ?? null, iso(nowMs + RETRY_MINUTES[0]! * MINUTE), opts.error, now())
  scheduleDrain(db, nowMs)
}

// Sends an email now, or queues it to try again later. Never throws.
export async function sendOrQueue(email: Email, opts: { kind: OutboxKind }, db: DatabaseSync = getDb()): Promise<boolean> {
  try {
    await sendEmail(email)
    return true
  } catch (err) {
    queueEmail(email, { kind: opts.kind, error: errorMessage(err, 'the email provider refused it') }, db)
    return false
  }
}

// A reply is being sent by hand ("Send again"): its queued retry is taken
// out first, so the two never both go. Returns the queued status, if any.
export function takeQueuedReply(eventId: number, db: DatabaseSync = getDb()): TicketStatus | null {
  const row = db.prepare('DELETE FROM email_outbox WHERE ticket_event_id = ? RETURNING then_status').get(eventId) as { then_status: TicketStatus | null } | undefined
  return row?.then_status ?? null
}

// When each of these replies will be tried again, if it's queued.
export function queuedReplies(eventIds: number[], db: DatabaseSync = getDb()): Map<number, string> {
  if (!eventIds.length) return new Map()
  const rows = db
    .prepare(`SELECT ticket_event_id, next_attempt_at FROM email_outbox WHERE ticket_event_id IN (${eventIds.map(() => '?').join(', ')})`)
    .all(...eventIds) as Array<{ ticket_event_id: number; next_attempt_at: string }>
  return new Map(rows.map((r) => [r.ticket_event_id, r.next_attempt_at]))
}

let running = false

// Tries every email that's due. One run at a time.
export async function drainOutbox(
  db: DatabaseSync = getDb(),
  send: (email: Email) => Promise<void> = sendEmail,
  nowMs = Date.now(),
): Promise<{ sent: number; failed: number }> {
  if (running) return { sent: 0, failed: 0 }
  running = true
  let sent = 0
  let failed = 0
  try {
    const due = db
      .prepare('SELECT id, kind, message, ticket_event_id, then_status, attempts FROM email_outbox WHERE next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?')
      .all(iso(nowMs), BATCH) as unknown as Row[]
    for (const row of due) {
      const attempts = row.attempts + 1
      const last = attempts >= MAX_ATTEMPTS
      const next = last ? null : iso(nowMs + RETRY_MINUTES[attempts - 1]! * MINUTE)
      // Claimed before sending (see above).
      db.prepare('UPDATE email_outbox SET attempts = ?, next_attempt_at = ? WHERE id = ?').run(attempts, next ?? iso(nowMs + 365 * 24 * 60 * MINUTE), row.id)
      try {
        await send(JSON.parse(row.message) as Email)
        db.prepare('DELETE FROM email_outbox WHERE id = ?').run(row.id)
        if (row.ticket_event_id !== null) replySentByRetry(row.ticket_event_id, row.then_status ?? 'pending', db)
        sent++
      } catch (err) {
        const error = errorMessage(err, 'the email provider refused it')
        failed++
        if (row.ticket_event_id !== null) replyFailedAgain(row.ticket_event_id, error, db)
        if (last) {
          db.prepare('DELETE FROM email_outbox WHERE id = ?').run(row.id)
          console.error(`[email] gave up on a ${row.kind} email after ${attempts} tries: ${error}`)
        } else {
          db.prepare('UPDATE email_outbox SET last_error = ? WHERE id = ?').run(error, row.id)
        }
      }
    }
  } finally {
    running = false
  }
  scheduleDrain(db, nowMs)
  return { sent, failed }
}

let timer: ReturnType<typeof setTimeout> | undefined

// Wakes for the next email due (at most an hour away; the hourly cleanup
// also runs it). Unref'd, so it never keeps the process alive on its own.
export function scheduleDrain(db: DatabaseSync = getDb(), nowMs = Date.now()): void {
  const row = db.prepare('SELECT min(next_attempt_at) AS due FROM email_outbox').get() as { due: string | null }
  if (timer) clearTimeout(timer)
  timer = undefined
  if (!row.due) return
  const wait = Math.min(Math.max(Date.parse(row.due) - nowMs, 1_000), 60 * MINUTE)
  timer = setTimeout(() => {
    timer = undefined
    drainOutbox(db).catch((err) => console.error('[email] retrying queued emails failed', err))
  }, wait)
  timer.unref?.()
}

// For tests: stop the wake-up timer.
export function cancelScheduledDrain(): void {
  if (timer) clearTimeout(timer)
  timer = undefined
}

const iso = (ms: number) => new Date(ms).toISOString()
