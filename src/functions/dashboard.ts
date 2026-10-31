import { createServerFn } from '@tanstack/react-start'
import { asObject, oneOf, str, uuid } from './validate.ts'
import { requireUser } from '../server/auth.server.ts'
import { getDb } from '../server/db.server.ts'
import * as mr from '../server/modelriver.server.ts'
import { listArticles } from '../server/content.server.ts'
import { archivedSessions, archiveSession, deleteAt, restoreSession } from '../server/archive.server.ts'
import { env } from '../server/env.server.ts'
import { conversationChanged, getOwnSession, localBySession, plainPreview, requireLocal, setLocalMode, waitingSessions } from '../server/dashboard-data.server.ts'
import { PAGE_SIZE, pageNumber, pageOf } from '../lib/paging.ts'
import { connectorById, connectorName, conversationEvents, maskEmail } from '../server/integrations.server.ts'
import { verificationStatus, type VerificationRow } from '../server/identity.server.ts'
import { draftSessions, openTicketCount } from '../server/tickets.server.ts'

// Team-side views. Conversation history is read from ModelRiver sessions; the
// only local data is which conversation a session belongs to and its mode.
// The helpers live in dashboard-data.server.ts so none of them can end up in
// the browser bundle.

// One page of the inbox. view "open": everything not archived, with anyone
// waiting for a person first (longest wait at the top), then newest first.
// view "archived": the archive, most recently archived first. The list comes
// from a shared copy of ModelRiver's (see recentSessions); local details are
// only looked up for the rows on this page.
export const listConversations = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    const o = asObject(input ?? {})
    return { view: oneOf(o, 'view', ['open', 'archived'] as const), page: pageNumber(o.page) }
  })
  .handler(async ({ data: { view, page } }) => {
    const me = requireUser()
    const { sessions: all, capped } = await mr.recentSessions()
    const archived = archivedSessions()
    // Sessions AI drafts started for tickets aren't conversations.
    const drafts = draftSessions()
    const sessions = all.filter((s) => !drafts.has(s.id) && archived.has(s.id) === (view === 'archived'))
    const waiting = view === 'open' ? waitingSessions() : new Map<string, string>()
    const ordered =
      view === 'archived'
        ? sessions.sort((a, b) => archived.get(b.id)!.localeCompare(archived.get(a.id)!))
        : [
            ...sessions.filter((s) => waiting.has(s.id)).sort((a, b) => waiting.get(a.id)!.localeCompare(waiting.get(b.id)!)),
            ...sessions.filter((s) => !waiting.has(s.id)),
          ]
    const paging = pageOf(ordered.length, page)
    const slice = ordered.slice(paging.offset, paging.offset + PAGE_SIZE)
    const local = localBySession(slice.map((s) => s.id))
    const rows = slice.map((s) => ({
      sessionId: s.id,
      conversationId: local.get(s.id)?.id ?? null,
      mode: local.get(s.id)?.mode ?? null,
      visitorName: local.get(s.id)?.visitorName || null,
      endedAt: local.get(s.id)?.endedAt ?? null,
      waitingSince: local.get(s.id)?.waitingSince ?? null,
      handoffReason: local.get(s.id)?.handoffReason ?? null,
      handledBy: local.get(s.id)?.handledBy ?? null,
      messageCount: s.message_count,
      lastActivityAt: s.last_activity_at,
      preview: s.last_message ? plainPreview(s.last_message.content) : '',
      previewRole: s.last_message?.role ?? null,
      archivedAt: archived.get(s.id) ?? null,
      deleteAt: archived.has(s.id) ? deleteAt(archived.get(s.id)!) : null,
    }))
    return {
      conversations: rows,
      ...paging,
      // How many of the listed conversations are waiting, on any page.
      waitingCount: sessions.filter((s) => waiting.has(s.id)).length,
      // Only the newest sessions are read; older ones aren't listed.
      capped,
      retentionHours: env.archiveRetentionHours,
      currentUserId: me.id,
    }
  })

// Closes the conversation (a visitor still in it sees that the team closed
// it) and moves it to the archive, where it is deleted after ARCHIVE_RETENTION_HOURS.
export const archiveConversation = createServerFn({ method: 'POST' })
  .validator((input: unknown) => ({ sessionId: uuid(asObject(input), 'sessionId') }))
  .handler(async ({ data }) => {
    const user = requireUser()
    await getOwnSession(data.sessionId)
    archiveSession(data.sessionId, user.name)
    conversationChanged(data.sessionId)
    return { archived: true }
  })

export const restoreConversation = createServerFn({ method: 'POST' })
  .validator((input: unknown) => ({ sessionId: uuid(asObject(input), 'sessionId') }))
  .handler(async ({ data }) => {
    requireUser()
    await getOwnSession(data.sessionId)
    restoreSession(data.sessionId)
    conversationChanged(data.sessionId)
    return { restored: true }
  })

// For the sidebar badges: how many visitors are waiting for a person, and how many tickets are open.
export const waitingCount = createServerFn({ method: 'GET' }).handler(() => {
  requireUser()
  const row = getDb()
    .prepare('SELECT count(*) AS n FROM conversations WHERE handoff_requested_at IS NOT NULL AND ended_at IS NULL')
    .get() as { n: number }
  return { waiting: row.n, tickets: openTicketCount() }
})

export const getTranscript = createServerFn({ method: 'POST' })
  .validator((input: unknown) => ({ sessionId: uuid(asObject(input), 'sessionId') }))
  .handler(async ({ data }) => {
    const me = requireUser()
    const session = await getOwnSession(data.sessionId)
    const local = localBySession([data.sessionId]).get(data.sessionId)
    const archivedAt = archivedSessions().get(data.sessionId) ?? null
    const verified = local
      ? (getDb().prepare('SELECT verified_email, verified_via, verified_at, verified_active_at FROM conversations WHERE id = ?').get(local.id) as
          | (VerificationRow & { verified_via: 'email_code' | 'identity_token' | null })
          | undefined)
      : undefined
    // Lapsed verifications are cleared on the visitor's next message; until then they don't count here either.
    const verifiedEmail = verified && verificationStatus(verified).state === 'active' ? verified.verified_email : null
    return {
      sessionId: session.id,
      conversationId: local?.id ?? null,
      mode: local?.mode ?? null,
      visitorName: local?.visitorName || null,
      endedAt: local?.endedAt ?? null,
      waitingSince: local?.waitingSince ?? null,
      handoffReason: local?.handoffReason ?? null,
      handledBy: local?.handledBy ?? null,
      currentUserId: me.id,
      archivedAt,
      deleteAt: archivedAt ? deleteAt(archivedAt) : null,
      insertedAt: session.inserted_at,
      truncated: session.truncated,
      messages: session.messages,
      // Public articles, so [[slug]] citations in AI answers render as links.
      articles: listArticles().map(({ slug, path, title }) => ({ slug, path, title })),
      // Who the visitor proved they are (masked), and what the AI looked up for them.
      verifiedAs: verifiedEmail ? { email: maskEmail(verifiedEmail), via: verified!.verified_via } : null,
      lookups: local
        ? conversationEvents(getDb(), local.id, 10).map((e) => {
            const c = connectorById(e.connector)
            return { ...e, service: c ? connectorName(getDb(), c) : e.connector }
          })
        : [],
    }
  })

export const agentReply = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const o = asObject(input)
    return { sessionId: uuid(o, 'sessionId'), text: str(o, 'text', { max: 8000 }) }
  })
  .handler(async ({ data }) => {
    const user = requireUser()
    const local = requireLocal(data.sessionId)
    // One person per conversation: someone else has to take it over first.
    if (local.handledBy && local.handledBy.id !== user.id) {
      throw new Error(`${local.handledBy.name} is handling this conversation. Take it over first if you need to reply.`)
    }
    // Replying is taking over: the AI stays quiet until someone hands back.
    setLocalMode(local.id, 'human', { handlerId: user.id })
    const message = await mr.appendSessionMessage(data.sessionId, { role: 'assistant', content: data.text, author_name: user.name })
    // The visitor has their answer, so they're no longer waiting.
    setLocalMode(local.id, 'human', { answered: true })
    // The reply itself arrives as a live message; this updates the rest (no longer waiting).
    conversationChanged(data.sessionId)
    return message
  })

export const setConversationMode = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const o = asObject(input)
    return { sessionId: uuid(o, 'sessionId'), mode: oneOf(o, 'mode', ['ai', 'human'] as const) }
  })
  .handler(async ({ data }) => {
    const user = requireUser()
    // Taking over (also from a colleague) makes you the one handling it.
    setLocalMode(requireLocal(data.sessionId).id, data.mode, { handlerId: data.mode === 'human' ? user.id : null })
    conversationChanged(data.sessionId)
    return { mode: data.mode }
  })

// A single-use token for this conversation's live updates (ModelRiver's
// session channel), so the open transcript shows new messages at once.
export const liveTranscript = createServerFn({ method: 'POST' })
  .validator((input: unknown) => ({ sessionId: uuid(asObject(input), 'sessionId') }))
  .handler(async ({ data }) => {
    requireUser()
    await getOwnSession(data.sessionId)
    const { ws_token, websocket_url, websocket_channel } = await mr.subscribeSession(data.sessionId)
    return { ws_token, websocket_url, websocket_channel }
  })
