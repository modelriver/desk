import type { DatabaseSync } from 'node:sqlite'
import { now } from './db.server.ts'

// Who has a conversation (the AI or the team), whether the visitor is waiting
// for a person and why, and which team member is handling it. Shared by the
// widget and dashboard functions; takes the database so it can be tested.

export type Mode = 'ai' | 'human'
export type HandoffReason = 'asked' | 'ai_error'

// Hand the chat to the team: the AI stops answering and the dashboard lists
// it first, flagged as waiting, until a team member replies. A visitor who is
// already waiting keeps their place and the original reason. Returns true
// when this started the wait (so the team is notified once, not every time).
export function markHandoff(db: DatabaseSync, conversationId: string, reason: HandoffReason): boolean {
  const before = db.prepare('SELECT handoff_requested_at FROM conversations WHERE id = ?').get(conversationId) as
    | { handoff_requested_at: string | null }
    | undefined
  db.prepare(
    `UPDATE conversations SET mode = 'human',
       handoff_reason = CASE WHEN handoff_requested_at IS NULL THEN ? ELSE handoff_reason END,
       handoff_requested_at = coalesce(handoff_requested_at, ?), last_activity_at = ?
     WHERE id = ?`,
  ).run(reason, now(), now(), conversationId)
  return before !== undefined && before.handoff_requested_at === null
}

// The team takes over or hands back. Taking over keeps the "waiting" flag (the
// visitor still has no answer); replying (answered) or handing back to the AI
// clears it. `handlerId` records who has the chat; handing back clears that too.
export function setTeamMode(
  db: DatabaseSync,
  conversationId: string,
  mode: Mode,
  { answered = false, handlerId = null }: { answered?: boolean; handlerId?: string | null } = {},
) {
  db.prepare(
    `UPDATE conversations SET mode = ?, last_activity_at = ?,
     handoff_requested_at = CASE WHEN ? THEN NULL ELSE handoff_requested_at END,
     assigned_user_id = CASE WHEN ? = 'ai' THEN NULL ELSE coalesce(?, assigned_user_id) END
     WHERE id = ?`,
  ).run(mode, now(), answered || mode === 'ai' ? 1 : 0, mode, handlerId, conversationId)
}

// The visitor goes back to the AI (only allowed while still waiting).
export function backToAi(db: DatabaseSync, conversationId: string) {
  db.prepare(
    "UPDATE conversations SET mode = 'ai', handoff_requested_at = NULL, assigned_user_id = NULL, last_activity_at = ? WHERE id = ?",
  ).run(now(), conversationId)
}
