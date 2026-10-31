import type { DatabaseSync } from 'node:sqlite'
import { getDb, now } from './db.server.ts'
import { env } from './env.server.ts'
import * as mr from './modelriver.server.ts'
import { pruneInsights } from './insights.server.ts'
import { draftSessions, forgetDraftSession, pruneTickets } from './tickets.server.ts'
import { pruneTicketAccess } from './ticket-access.server.ts'
import { drainOutbox } from './outbox.server.ts'

// Archiving closes a conversation and hides it from the main list. After
// ARCHIVE_RETENTION_HOURS it is deleted for good: the ModelRiver session
// (its whole history) and the local row. Restoring before then cancels that.

const HOUR = 3_600_000

export function archiveSession(sessionId: string, archivedBy: string, db: DatabaseSync = getDb()) {
  const ts = now()
  db.prepare('INSERT OR IGNORE INTO archived_sessions (session_id, archived_at, archived_by) VALUES (?, ?, ?)').run(
    sessionId,
    ts,
    archivedBy,
  )
  // A visitor still in this chat sees that the team closed it (see currentConversation in functions/chat.ts).
  db.prepare(
    `UPDATE conversations SET ended_at = coalesce(ended_at, ?), handoff_requested_at = NULL,
       verified_email = NULL, verified_at = NULL, verified_via = NULL, verified_active_at = NULL
     WHERE modelriver_session_id = ?`,
  ).run(ts, sessionId)
  // Closed: the visitor's proved email isn't needed any more.
  db.prepare('DELETE FROM visitor_codes WHERE conversation_id IN (SELECT id FROM conversations WHERE modelriver_session_id = ?)').run(sessionId)
}

// Back to the main list. The conversation stays ended: the visitor can't reopen it.
export function restoreSession(sessionId: string, db: DatabaseSync = getDb()) {
  db.prepare('DELETE FROM archived_sessions WHERE session_id = ?').run(sessionId)
}

// session id -> when it was archived.
export function archivedSessions(db: DatabaseSync = getDb()): Map<string, string> {
  const rows = db.prepare('SELECT session_id, archived_at FROM archived_sessions').all() as Array<{
    session_id: string
    archived_at: string
  }>
  return new Map(rows.map((r) => [r.session_id, r.archived_at]))
}

// When an archived conversation will be deleted, or null if it's kept.
export function deleteAt(archivedAt: string, retentionHours = env.archiveRetentionHours): string | null {
  if (retentionHours <= 0) return null
  return new Date(Date.parse(archivedAt) + retentionHours * HOUR).toISOString()
}

// Deletes conversations archived at least `retentionHours` ago. A session that
// is already gone in ModelRiver counts as deleted; other failures are left
// for the next run. Returns how many were deleted.
export async function cleanupArchived({
  retentionHours = env.archiveRetentionHours,
  at = Date.now(),
  db = getDb(),
  workflow = env.workflow,
  getWorkflow = async (sessionId: string) => (await mr.getSession(sessionId)).workflow,
  deleteSession = mr.deleteSession,
}: {
  retentionHours?: number
  at?: number
  db?: DatabaseSync
  workflow?: string
  getWorkflow?: (sessionId: string) => Promise<string>
  deleteSession?: (sessionId: string) => Promise<void>
} = {}): Promise<number> {
  if (retentionHours <= 0) return 0
  const cutoff = new Date(at - retentionHours * HOUR).toISOString()
  const due = db
    .prepare('SELECT session_id FROM archived_sessions WHERE archived_at <= ? ORDER BY archived_at LIMIT 200')
    .all(cutoff) as Array<{ session_id: string }>
  let deleted = 0
  for (const { session_id } of due) {
    try {
      // Belt and braces: archiving already checks this, but a session from
      // another workflow is never deleted, only taken out of the archive.
      if ((await getWorkflow(session_id)) !== workflow) {
        console.warn(`[archive] session ${session_id} belongs to another workflow; not deleting it`)
        db.prepare('DELETE FROM archived_sessions WHERE session_id = ?').run(session_id)
        continue
      }
      await deleteSession(session_id)
    } catch (err) {
      if (!(err instanceof mr.ModelRiverError && err.status === 404)) {
        console.error(`[archive] could not delete session ${session_id}; will retry`, err)
        continue
      }
    }
    db.prepare('DELETE FROM conversations WHERE modelriver_session_id = ?').run(session_id)
    db.prepare('DELETE FROM archived_sessions WHERE session_id = ?').run(session_id)
    deleted++
  }
  return deleted
}

// Sign-in sessions, half-finished sign-ins and email codes past their expiry.
// An email code stays while its lockout is still running.
export function pruneExpired(db: DatabaseSync = getDb()): number {
  const ts = now()
  return (
    pruneTicketAccess(db) +
    Number(db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(ts).changes) +
    Number(db.prepare('DELETE FROM login_challenges WHERE expires_at <= ?').run(ts).changes) +
    Number(
      db
        .prepare('DELETE FROM visitor_codes WHERE expires_at <= ? AND (locked_until IS NULL OR locked_until <= ?)')
        .run(ts, ts).changes,
    )
  )
}

// Sessions AI drafts started that couldn't be deleted at once (see
// draftTicketReply): tried again; one already gone counts as deleted.
export async function cleanupDraftSessions(deleteSession = mr.deleteSession, db: DatabaseSync = getDb()): Promise<number> {
  let done = 0
  for (const id of draftSessions(db)) {
    try {
      await deleteSession(id)
    } catch (err) {
      if (!(err instanceof mr.ModelRiverError && err.status === 404)) continue
    }
    forgetDraftSession(id, db)
    done++
  }
  return done
}

// Runs the hourly cleanup in the production server (server.mjs): archived
// conversations past their retention, unanswered questions older than 90 days,
// tickets solved more than 90 days ago, expired sign-ins and codes, and
// emails waiting to be tried again. The timers
// are unref'd so they never keep the process alive on their own.
export function scheduleCleanup(): void {
  const run = () => {
    try {
      const pruned = pruneInsights()
      if (pruned > 0) console.log(`[insights] forgot ${pruned} unanswered question${pruned === 1 ? '' : 's'} older than 90 days`)
    } catch (err) {
      console.error('[insights] cleanup failed', err)
    }
    try {
      const pruned = pruneTickets()
      if (pruned > 0) console.log(`[tickets] deleted ${pruned} ticket${pruned === 1 ? '' : 's'} solved more than 90 days ago`)
    } catch (err) {
      console.error('[tickets] cleanup failed', err)
    }
    try {
      pruneExpired()
    } catch (err) {
      console.error('[cleanup] removing expired sign-ins failed', err)
    }
    cleanupArchived()
      .then((n) => n > 0 && console.log(`[archive] deleted ${n} archived conversation${n === 1 ? '' : 's'}`))
      .catch((err) => console.error('[archive] cleanup failed', err))
    cleanupDraftSessions().catch((err) => console.error('[tickets] removing draft sessions failed', err))
    // Emails queued before a restart (each run also sets a timer for the next one due).
    drainOutbox().catch((err) => console.error('[email] retrying queued emails failed', err))
  }
  setTimeout(run, 60_000).unref()
  setInterval(run, HOUR).unref()
}
