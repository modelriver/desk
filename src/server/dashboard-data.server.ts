import { getDb } from './db.server.ts'
import { env } from './env.server.ts'
import * as mr from './modelriver.server.ts'
import { setTeamMode, type HandoffReason, type Mode } from './conversation-state.server.ts'
import { CONVERSATION_UPDATED } from '../lib/live.ts'

// Lookups and updates behind the dashboard's server functions (functions/dashboard.ts).

// One-line preview: drop citation markers and Markdown punctuation.
export function plainPreview(content: string): string {
  return content
    .replace(/\[\[[a-z0-9-]+\]\]/g, '')
    .replace(/[*_`#>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160)
}

// The team member handling a conversation.
type Handler = { id: string; name: string }

type Local = {
  id: string
  mode: Mode
  visitorName: string
  endedAt: string | null
  waitingSince: string | null
  handoffReason: HandoffReason | null
  handledBy: Handler | null
}

// Conversations waiting for a person, by session, with when they asked. Read on
// every inbox poll, so it only touches the few waiting rows (conversations_waiting index).
export function waitingSessions(): Map<string, string> {
  const rows = getDb()
    .prepare(
      `SELECT modelriver_session_id AS session_id, handoff_requested_at AS since FROM conversations
       WHERE handoff_requested_at IS NOT NULL AND ended_at IS NULL AND modelriver_session_id IS NOT NULL`,
    )
    .all() as Array<{ session_id: string; since: string }>
  return new Map(rows.map((r) => [r.session_id, r.since]))
}

export function localBySession(sessionIds: string[]) {
  if (!sessionIds.length) return new Map<string, Local>()
  const rows = getDb()
    .prepare(
      `SELECT c.id, c.mode, c.visitor_name, c.ended_at, c.handoff_requested_at, c.handoff_reason, c.modelriver_session_id,
              u.id AS handler_id, u.name AS handler_name
       FROM conversations c LEFT JOIN users u ON u.id = c.assigned_user_id
       WHERE c.modelriver_session_id IN (${sessionIds.map(() => '?').join(',')})`,
    )
    .all(...sessionIds) as Array<{
    id: string
    mode: Mode
    visitor_name: string
    ended_at: string | null
    handoff_requested_at: string | null
    handoff_reason: HandoffReason | null
    modelriver_session_id: string
    handler_id: string | null
    handler_name: string | null
  }>
  return new Map<string, Local>(
    rows.map((r) => [
      r.modelriver_session_id,
      {
        id: r.id,
        mode: r.mode,
        visitorName: r.visitor_name,
        endedAt: r.ended_at,
        waitingSince: r.handoff_requested_at,
        handoffReason: r.handoff_requested_at ? (r.handoff_reason ?? 'asked') : null,
        // Only while the team has the chat.
        handledBy: r.mode === 'human' && r.handler_id ? { id: r.handler_id, name: r.handler_name ?? 'A team member' } : null,
      },
    ]),
  )
}

// The API key may reach every session in the ModelRiver project; the
// dashboard only ever shows or changes this app's workflow.
export async function getOwnSession(sessionId: string) {
  const session = await mr.getSession(sessionId)
  if (session.workflow !== env.workflow) throw new Error('Session not found.')
  return session
}

export function requireLocal(sessionId: string) {
  const local = localBySession([sessionId]).get(sessionId)
  if (!local) throw new Error('This session did not start in the support widget, so it is read-only here.')
  if (local.endedAt) throw new Error('The visitor ended this conversation, so it can’t be replied to.')
  return local
}

export function setLocalMode(conversationId: string, mode: Mode, options?: { answered?: boolean; handlerId?: string | null }) {
  setTeamMode(getDb(), conversationId, mode, options)
}

// Open widgets and transcripts for this conversation reload it.
export function conversationChanged(sessionId: string | null | undefined) {
  if (sessionId) mr.signalSession(sessionId, CONVERSATION_UPDATED)
}
