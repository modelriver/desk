import { createServerFn } from '@tanstack/react-start'
import { asObject, str, uuid } from './validate.ts'
import { buildContextMessage, type Source } from '../lib/prompt-core.ts'
import { getDb, now } from '../server/db.server.ts'
import { clientIp } from '../server/auth.server.ts'
import { allowAll } from '../server/rate-limit.server.ts'
import { env } from '../server/env.server.ts'
import { hashToken, newToken } from '../server/password.server.ts'
import { listArticles, searchContent } from '../server/content.server.ts'
import * as mr from '../server/modelriver.server.ts'
import { clearVisitorCookie, deviceId, readVisitorCookie, writeVisitorCookie } from '../server/visitor.server.ts'
import { recordEnd, restartWaitSeconds } from '../server/restart-cooldown.server.ts'
import { cleanVisitorName } from '../server/visitor-cookie.ts'
import { wantsHuman } from '../lib/handoff.ts'
import * as state from '../server/conversation-state.server.ts'
import { recordAiAccepted, recordAiFailure } from '../server/status.server.ts'
import { notifyTeam } from '../server/notifications.server.ts'
import { recordGap } from '../server/insights.server.ts'
import type { HandoffReason } from '../server/conversation-state.server.ts'
import { conversationChanged } from '../server/dashboard-data.server.ts'
import { accountContext } from '../server/account-context.server.ts'
import {
  clearVerification,
  confirmEmailCode as confirmCode,
  currentVerification,
  IdentityError,
  identityMethods,
  issueEmailCode,
  markVerified,
  normalizeEmail,
  verifyIdentityToken,
} from '../server/identity.server.ts'
import { lookupHints, maskEmail } from '../server/integrations.server.ts'
import { sendEmail } from '../server/email.server.ts'
import { getSiteConfig } from '../server/site-config.server.ts'
import { errorMessage } from '../lib/errors.ts'
import { escapeHtml } from '../lib/escape.ts'
import { CHAT_PAUSED_MESSAGE, chatEnabled } from '../server/chat-availability.server.ts'
import { avatarsByName } from '../server/avatars.server.ts'

// Public chat endpoints used by the widget. A conversation is identified by an
// HttpOnly cookie holding its id plus a random visitor token (stored hashed).

export interface StreamTicket {
  channelId: string
  websocketUrl: string
  websocketChannel: string
  wsToken: string
}

export interface WidgetMessage {
  id: string
  role: 'user' | 'assistant'
  author: 'user' | 'ai' | 'agent'
  authorName?: string | null
  // A team member's profile picture (/avatars/…), when they've set one.
  authorAvatar?: string | null
  content: string
}

const MAX_MESSAGE = 4000
// Shown when the visitor's cookie is missing or stale; the widget then asks
// for their name and starts a new conversation.
export const CONVERSATION_NOT_FOUND = 'Conversation not found.'
// Shown when the team archived the conversation while the visitor was in it.
export const CONVERSATION_CLOSED = 'Our team closed this conversation.'
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

// Errors whose message is safe to show visitors. Anything else (ModelRiver
// failures, missing config) is logged and replaced with a generic message.
class VisitorError extends Error {}

async function visitorSafe<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof VisitorError) throw err
    console.error('[chat]', err)
    throw new Error('The assistant is unavailable right now. Please try again in a moment.')
  }
}

export const startConversation = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const name = cleanVisitorName(asObject(input).name)
    if (!name) throw new Error('Please enter your name (up to 60 characters).')
    return { name }
  })
  .handler(({ data }) =>
    visitorSafe(() => {
      if (!chatEnabled()) throw new VisitorError(CHAT_PAUSED_MESSAGE)
      // Pacing after "End conversation": returns the wait instead of starting.
      const keys = { device: deviceId(true), ip: clientIp() }
      const wait = restartWaitSeconds(keys)
      if (wait > 0) return { started: false as const, retryAfterSeconds: wait }
      const allowed = allowAll([
        { key: `conv:${keys.ip}`, max: 20, windowMs: HOUR },
        { key: 'conv-global', max: 1000, windowMs: HOUR },
      ])
      if (!allowed) throw new VisitorError('Too many new conversations. Please wait a bit.')
      const id = crypto.randomUUID()
      const visitorToken = newToken()
      const ts = now()
      getDb()
        .prepare(
          'INSERT INTO conversations (id, visitor_token_hash, visitor_name, mode, created_at, last_activity_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(id, hashToken(visitorToken), data.name, 'ai', ts, ts)
      writeVisitorCookie(id, visitorToken)
      return { started: true as const, name: data.name }
    }),
  )

// The visitor ends their conversation. It stays in the dashboard (marked
// ended, no more replies); their browser forgets it, and starting another one
// soon after is paced by restart-cooldown.server.ts.
export const endConversation = createServerFn({ method: 'POST' }).handler(() =>
  visitorSafe(() => {
    if (!allowAll([{ key: `end-ip:${clientIp()}`, max: 20, windowMs: HOUR }])) {
      throw new VisitorError('Too many requests. Please wait a moment.')
    }
    const conv = currentConversation()
    clearVisitorCookie()
    // Only a conversation that really ended counts towards the restart wait.
    // Otherwise anyone could post here without a cookie and run up the wait
    // for everyone sharing their IP address.
    if (conv) {
      getDb()
        .prepare('UPDATE conversations SET ended_at = ?, handoff_requested_at = NULL, last_activity_at = ? WHERE id = ?')
        .run(now(), now(), conv.id)
      clearVerification(getDb(), conv.id)
      recordEnd({ device: deviceId(true), ip: clientIp() })
      conversationChanged(conv.modelriver_session_id)
    }
    return { retryAfterSeconds: restartWaitSeconds({ device: deviceId(false), ip: clientIp() }) }
  }),
)

type ConversationRow = {
  id: string
  visitor_name: string
  modelriver_session_id: string | null
  mode: 'ai' | 'human'
  last_channel_id: string | null
  handoff_requested_at: string | null
  handoff_reason: HandoffReason | null
  // Proved by an email code or an identity token; connector lookups use it.
  verified_email: string | null
}

export type { HandoffReason }

// The conversation named by the visitor cookie. `conv` is null (and the
// cookie cleared) when the cookie is missing, malformed or no longer matches
// an open conversation. `closedBy` is the visitor's name when the cookie still
// pointed at an ended one: visitors who end a chat lose the cookie then, so
// that means the team archived it while they were in it.
function readConversation(): { conv: (ConversationRow & { token: string }) | null; closedFor: string | null } {
  const cookie = readVisitorCookie()
  if (!cookie) return { conv: null, closedFor: null }
  const row = getDb()
    .prepare(
      `SELECT id, visitor_name, modelriver_session_id, mode, last_channel_id, handoff_requested_at, handoff_reason, verified_email, ended_at
       FROM conversations
       WHERE id = ? AND visitor_token_hash = ?`,
    )
    .get(cookie.conversationId, hashToken(cookie.token)) as (ConversationRow & { ended_at: string | null }) | undefined
  if (!row || row.ended_at) {
    clearVisitorCookie()
    return { conv: null, closedFor: row ? row.visitor_name : null }
  }
  const { ended_at: _ended, ...conv } = row
  return { conv: { ...conv, token: cookie.token }, closedFor: null }
}

function currentConversation() {
  return readConversation().conv
}

function requireConversation() {
  const { conv, closedFor } = readConversation()
  if (closedFor !== null) throw new VisitorError(CONVERSATION_CLOSED)
  if (!conv) throw new VisitorError(CONVERSATION_NOT_FOUND)
  return conv
}

// Hands the chat to the team and, the first time, lets them know by email.
function markHandoff(
  conv: { id: string; visitor_name: string; modelriver_session_id: string | null },
  reason: HandoffReason,
  text: string | null = null,
) {
  if (state.markHandoff(getDb(), conv.id, reason)) {
    notifyTeam({ kind: 'handoff', reason, visitorName: conv.visitor_name, sessionId: conv.modelriver_session_id, text })
  }
  conversationChanged(conv.modelriver_session_id)
}

// The AI couldn't answer (ModelRiver or the model failed, or the site-wide AI
// budget is used up). Instead of an error, the question goes to the team, as
// long as there's a session to put it in. Without one (the very first
// message), the team couldn't see it, so the visitor gets a gentle retry message.
async function handOffAfterAiFailure(conv: { id: string; visitor_name: string }, sessionId: string | null, text: string, cause: unknown) {
  console.error('[chat] the AI could not answer; handing the chat to the team', cause)
  recordAiFailure(typeof cause === 'string' ? cause : errorMessage(cause, 'The AI request failed'))
  recordGap({ question: text, reason: 'ai_error', sessionId })
  if (!sessionId) throw new VisitorError('Our assistant couldn’t answer just now. Please try again in a moment.')
  markHandoff({ ...conv, modelriver_session_id: sessionId }, 'ai_error', text)
  await mr.appendSessionMessage(sessionId, { role: 'user', content: text })
  return { mode: 'human' as const, stream: null, sources: [] as Source[], handoff: true, handoffReason: 'ai_error' as HandoffReason, verify: null, checked: [] as string[] }
}

function waitingSeconds(requestedAt: string | null): number | null {
  if (!requestedAt) return null
  return Math.max(0, Math.round((Date.now() - Date.parse(requestedAt)) / 1000))
}

export const sendMessage = createServerFn({ method: 'POST' })
  .validator((input: unknown) => ({ text: str(asObject(input), 'text', { max: MAX_MESSAGE }) }))
  .handler(({ data }) =>
    visitorSafe(async () => {
      if (!chatEnabled()) throw new VisitorError(CHAT_PAUSED_MESSAGE)
      const conv = requireConversation()
      const allowed = allowAll([
        { key: `msg:${conv.id}`, max: 20, windowMs: 10 * MINUTE },
        { key: `msg-ip:${clientIp()}`, max: 60, windowMs: 10 * MINUTE },
      ])
      if (!allowed) throw new VisitorError('You are sending messages too quickly. Please wait a moment.')
      const db = getDb()
      db.prepare('UPDATE conversations SET last_activity_at = ? WHERE id = ?').run(now(), conv.id)
      // Slide the cookie's expiry forward while the visitor is active.
      writeVisitorCookie(conv.id, conv.token)

      // "Can I talk to a person?" and similar: hand off before the AI is
      // called. Requests phrased any other way are caught by the AI, which
      // ends its reply with [[handoff]] (see prompt-core.ts).
      const handoff = conv.mode === 'ai' && wantsHuman(data.text)
      if (handoff) markHandoff(conv, 'asked', data.text)
      const handoffReason: HandoffReason | null = handoff ? 'asked' : null

      // The team has the chat: store the message in the session for them.
      if ((conv.mode === 'human' || handoff) && conv.modelriver_session_id) {
        await mr.appendSessionMessage(conv.modelriver_session_id, { role: 'user', content: data.text })
        return { mode: 'human' as const, stream: null, sources: [] as Source[], handoff, handoffReason, verify: null, checked: [] as string[] }
      }
      // With no session yet there is nowhere to store the message, so the AI
      // is still called once (which creates the session) to acknowledge it.
      const waiting = conv.mode === 'human' || handoff

      // Site-wide caps on AI answers: they bound model spend even when a flood
      // comes from many IPs that each stay under their own limits.
      const withinBudget = allowAll([
        { key: 'ai-global-minute', max: env.globalMessagesPerMinute, windowMs: MINUTE },
        { key: 'ai-global-day', max: env.globalMessagesPerDay, windowMs: DAY },
      ])
      if (!withinBudget) {
        // People can still help when the AI budget is used up.
        return handOffAfterAiFailure(conv, conv.modelriver_session_id, data.text, 'site-wide AI budget used up')
      }

      const matches = searchContent(data.text, 6)
      const context = buildContextMessage(matches)
      // The visitor's own orders, billing or bookings, from connectors. A
      // failing connector never fails the answer: the AI is told it's unavailable.
      // A message from the visitor keeps their verification alive; one that
      // has lapsed (VERIFIED_HOURS, or 2 hours without a message) is cleared.
      const verification = currentVerification(db, conv.id, { touch: true })
      const account = await accountContext(db, {
        conversation: { ...conv, verified_email: verification.email },
        text: data.text,
        ip: clientIp(),
        waiting,
        verificationExpired: verification.expired,
      })
      const system =
        withVisitorName(context.content, conv.visitor_name) + (account.message ? `\n\n${account.message}` : '') + (waiting ? WAITING_NOTE : '')
      const ask = (sessionId: string | null) =>
        mr.startAsyncRequest({
          sessionId,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: data.text },
          ],
          metadata: { conversation_id: conv.id, visitor_name: conv.visitor_name },
        })
      let accepted: mr.AsyncAccepted
      let sessionId = conv.modelriver_session_id
      try {
        try {
          accepted = await ask(sessionId)
        } catch (err) {
          // The session was deleted in ModelRiver: start a fresh one instead of failing forever.
          if (!(err instanceof mr.ModelRiverError && err.code === 'session_not_found')) throw err
          db.prepare("UPDATE conversations SET modelriver_session_id = NULL, mode = 'ai' WHERE id = ?").run(conv.id)
          sessionId = null
          accepted = await ask(null)
        }
      } catch (err) {
        return handOffAfterAiFailure(conv, sessionId, data.text, err)
      }
      recordAiAccepted()
      // Nothing in the articles or notes matched: a gap for the team to fill.
      if (!matches.length) recordGap({ question: data.text, reason: 'no_match', sessionId: accepted.session_id ?? sessionId })
      // The first answered message starts the session: a new conversation for the team.
      if (!sessionId && accepted.session_id) {
        notifyTeam({ kind: 'new_conversation', visitorName: conv.visitor_name, sessionId: accepted.session_id, text: data.text })
      }
      db.prepare(
        'UPDATE conversations SET modelriver_session_id = coalesce(?, modelriver_session_id), last_channel_id = ? WHERE id = ?',
      ).run(accepted.session_id, accepted.channel_id, conv.id)
      const stream: StreamTicket = {
        channelId: accepted.channel_id,
        websocketUrl: accepted.websocket_url,
        websocketChannel: accepted.websocket_channel,
        wsToken: accepted.ws_token,
      }
      return { mode: 'ai' as const, stream, sources: context.sources, handoff, handoffReason, verify: account.verify, checked: account.checked }
    }),
  )

// The visitor asked for a person through the chat menu, or the AI ended its
// answer with [[handoff]].
export const requestHandoff = createServerFn({ method: 'POST' }).handler(() =>
  visitorSafe(() => {
    const conv = requireConversation()
    if (!allowAll([{ key: `handoff:${conv.id}`, max: 10, windowMs: HOUR }])) {
      throw new VisitorError('Too many requests. Please wait a moment.')
    }
    // The team works from the session's history, so there has to be one.
    if (!conv.modelriver_session_id) throw new VisitorError('Send us your question first, then we’ll pass it to the team.')
    markHandoff(conv, 'asked')
    return {
      mode: 'human' as const,
      handoffWaitingSeconds: waitingSeconds(conv.handoff_requested_at) ?? 0,
      handoffReason: (conv.handoff_reason ?? 'asked') as HandoffReason,
    }
  }),
)

// The widget reports that the answer failed while streaming (a model error,
// a timeout or a lost connection). ModelRiver has already recorded the
// question in the session, so the team sees it; the chat goes to them.
export const handOffAfterAiError = createServerFn({ method: 'POST' })
  .validator((input: unknown) => ({ question: optionalQuestion(input) }))
  .handler(({ data }) =>
    visitorSafe(() => {
      const conv = requireConversation()
      if (!allowAll([{ key: `ai-error:${conv.id}`, max: 10, windowMs: HOUR }])) {
        throw new VisitorError('Too many requests. Please wait a moment.')
      }
      // Nothing to hand over without a session: the widget asks them to try again.
      if (!conv.modelriver_session_id) return { handedOff: false as const }
      console.error(`[chat] an answer failed for conversation ${conv.id}; handing the chat to the team`)
      recordAiFailure('An answer failed while streaming (model error, timeout or lost connection)')
      if (data.question) recordGap({ question: data.question, reason: 'ai_error', sessionId: conv.modelriver_session_id })
      markHandoff(conv, 'ai_error', data.question)
      const waiting = waitingSeconds(conv.handoff_requested_at) ?? 0
      return {
        handedOff: true as const,
        handoffWaitingSeconds: waiting,
        handoffReason: (conv.handoff_reason && conv.handoff_requested_at ? conv.handoff_reason : 'ai_error') as HandoffReason,
      }
    }),
  )

// The AI ended its answer with [[unsure]]: the help articles didn't cover the
// visitor's question. The widget reports it so the team sees it under Insights.
export const reportUnanswered = createServerFn({ method: 'POST' })
  .validator((input: unknown) => ({ question: str(asObject(input), 'question', { max: MAX_MESSAGE }) }))
  .handler(({ data }) =>
    visitorSafe(() => {
      const conv = requireConversation()
      // Bounded, since the text comes from the visitor's browser.
      if (!allowAll([{ key: `unanswered:${conv.id}`, max: 10, windowMs: HOUR }])) return { recorded: false }
      return { recorded: recordGap({ question: data.question, reason: 'unsure', sessionId: conv.modelriver_session_id }) }
    }),
  )

function optionalQuestion(input: unknown): string | null {
  const q = input && typeof input === 'object' ? (input as Record<string, unknown>).question : undefined
  return typeof q === 'string' && q.trim() ? q.slice(0, MAX_MESSAGE) : null
}

// The visitor would rather keep going with the AI than wait for the team.
// Only while they're still waiting: once a team member has replied (or taken
// over), the chat stays with the team until they hand it back.
export const switchToAi = createServerFn({ method: 'POST' }).handler(() =>
  visitorSafe(() => {
    const conv = requireConversation()
    if (conv.mode === 'human' && !conv.handoff_requested_at) {
      throw new VisitorError('A team member is handling this chat now, so it can’t be switched back to the AI.')
    }
    if (!allowAll([{ key: `to-ai:${conv.id}`, max: 10, windowMs: HOUR }])) {
      throw new VisitorError('Too many requests. Please wait a moment.')
    }
    state.backToAi(getDb(), conv.id)
    conversationChanged(conv.modelriver_session_id)
    return { mode: 'ai' as const }
  }),
)

// A single-use token for live updates on the visitor's own conversation
// (ModelRiver's session channel): a team member's replies and takeovers show
// up at once instead of on the next poll. Null until the conversation has a
// session (its first message); the widget polls until then.
export const liveConversation = createServerFn({ method: 'POST' }).handler(() =>
  visitorSafe(async () => {
    const conv = requireConversation()
    if (!conv.modelriver_session_id) return null
    // Each token is a ModelRiver API call: reconnections are fine, a loop isn't.
    const allowed = allowAll([
      { key: `live:${conv.id}`, max: 20, windowMs: 10 * MINUTE },
      { key: `live-ip:${clientIp()}`, max: 60, windowMs: 10 * MINUTE },
    ])
    if (!allowed) throw new VisitorError('Too many requests. Please wait a moment.')
    const { ws_token, websocket_url, websocket_channel } = await mr.subscribeSession(conv.modelriver_session_id)
    return { ws_token, websocket_url, websocket_channel }
  }),
)

// The visitor's conversation, or { conversation: null } before they have
// started one (the widget then asks for their name).
// `fresh` skips the short cache: the widget asks for it when a live update
// says something just changed.
export const getConversation = createServerFn({ method: 'POST' })
  .validator((input: unknown) => ({ fresh: input != null && asObject(input).fresh === true }))
  .handler(({ data }) =>
  visitorSafe(async () => {
    const articles: Source[] = listArticles().map(({ slug, path, title }) => ({ slug, path, title }))
    const { conv, closedFor } = readConversation()
    if (!conv) {
      // No conversation: the widget asks for a name, showing any wait first,
      // or says the team closed the one they were in.
      const retryAfterSeconds = restartWaitSeconds({ device: deviceId(false), ip: clientIp() })
      return { conversation: null, messages: [] as WidgetMessage[], articles, retryAfterSeconds, closedFor }
    }
    // The widget polls every 4-10 seconds; this leaves room for reloads but
    // stops a script from hammering ModelRiver through us.
    const allowed = allowAll([
      { key: `poll:${conv.id}`, max: 30, windowMs: MINUTE },
      { key: `poll-ip:${clientIp()}`, max: 120, windowMs: MINUTE },
    ])
    if (!allowed) throw new VisitorError('Too many requests. Please wait a moment.')
    const conversation = {
      name: conv.visitor_name,
      mode: conv.mode,
      // How long the visitor has been waiting for a person (null when not
      // waiting). Seconds rather than a timestamp, so the visitor's clock doesn't matter.
      handoffWaitingSeconds: waitingSeconds(conv.handoff_requested_at),
      handoffReason: conv.handoff_requested_at ? (conv.handoff_reason ?? 'asked') : null,
      // Whether there's a ModelRiver session yet, so live updates can follow it.
      hasSession: conv.modelriver_session_id !== null,
      // Reloads don't count as activity, so an idle open chat still lapses.
      account: accountState(currentVerification(getDb(), conv.id, { touch: false })),
    }
    if (!conv.modelriver_session_id) return { conversation, messages: [] as WidgetMessage[], articles }
    let session: mr.SessionDetail
    try {
      session = await (data.fresh ? mr.getSession : mr.getSessionCached)(conv.modelriver_session_id)
    } catch (err) {
      // History is temporarily unavailable; the chat itself still works.
      console.error('[chat] could not load session history', err)
      return { conversation, messages: null, articles }
    }
    // Only the conversation's own turns; anything else ModelRiver might add
    // to a session (such as instructions) never reaches the visitor.
    const turns = session.messages.filter((m) => m.role === 'user' || m.role === 'assistant')
    const avatars = avatarsByName(turns.flatMap((m) => (m.author === 'agent' && m.author_name ? [m.author_name] : [])))
    const messages: WidgetMessage[] = turns.map((m) => ({
      id: m.id,
      role: m.role,
      author: m.author,
      authorName: m.author_name,
      authorAvatar: m.author === 'agent' && m.author_name ? (avatars.get(m.author_name) ?? null) : null,
      content: m.content,
    }))
    return { conversation, messages, articles }
  }),
)

// What the widget needs for account lookups: who the visitor is verified as
// (masked), whether they can verify by email, and the words that trigger a
// lookup, so it can say "Checking your account…" while one runs.
function accountState(verification: { email: string | null; expired: boolean }) {
  const hints = lookupHints(getDb())
  return {
    verifiedEmail: verification.email ? maskEmail(verification.email) : null,
    // It just lapsed: the widget can say so, and re-send a signed-in visitor's token.
    verificationExpired: verification.expired,
    lookups: hints.enabled,
    canVerify: hints.enabled && identityMethods().emailCode,
    lookupAlways: hints.always,
    lookupPatterns: hints.patterns,
  }
}

function asVisitorError(err: unknown): never {
  if (err instanceof IdentityError) throw new VisitorError(err.message)
  throw err
}

// Step 1 of verifying an email: a 6-digit code is sent to it.
export const requestEmailCode = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const email = normalizeEmail(asObject(input).email)
    if (!email) throw new Error('Enter a valid email address.')
    return { email }
  })
  .handler(({ data }) =>
    visitorSafe(async () => {
      const conv = requireConversation()
      if (!identityMethods().emailCode || !lookupHints(getDb()).enabled) {
        throw new VisitorError('Email verification isn’t available in this chat.')
      }
      // Each code is an email to an address the visitor typed: limited per
      // chat, per IP and site-wide, so the form can't be used to spam people.
      const allowed = allowAll([
        { key: `verify-send:${conv.id}`, max: 3, windowMs: 10 * MINUTE },
        { key: `verify-send-ip:${clientIp()}`, max: 10, windowMs: 10 * MINUTE },
        { key: 'verify-send-global', max: 200, windowMs: HOUR },
      ])
      if (!allowed) throw new VisitorError('That’s a few codes already. Please wait a few minutes.')
      let code: string
      try {
        code = issueEmailCode(getDb(), conv.id, data.email)
      } catch (err) {
        asVisitorError(err)
      }
      const brand = getSiteConfig().config.brand.name
      const text = `Your ${brand} verification code is ${code}.\n\nIt expires in 10 minutes. Enter it in the chat so we can look up your account.\n\nIf you didn’t ask for this, you can ignore this email.`
      await sendEmail({
        to: data.email,
        subject: `${code} is your ${brand} verification code`,
        text,
        html: `<div style="font-family:system-ui,sans-serif"><p>Your ${escapeHtml(brand)} verification code is</p><p style="font-size:28px;font-weight:600;letter-spacing:4px">${code}</p><p>It expires in 10 minutes. Enter it in the chat so we can look up your account.</p><p style="color:#666">If you didn’t ask for this, you can ignore this email.</p></div>`,
      })
      return { sentTo: maskEmail(data.email) }
    }),
  )

// Step 2: the code from the email. Five wrong codes lock it for 15 minutes.
export const confirmEmailCode = createServerFn({ method: 'POST' })
  .validator((input: unknown) => ({ code: str(asObject(input), 'code', { max: 12 }) }))
  .handler(({ data }) =>
    visitorSafe(() => {
      const conv = requireConversation()
      if (!allowAll([{ key: `verify-check-ip:${clientIp()}`, max: 30, windowMs: 10 * MINUTE }])) {
        throw new VisitorError('Too many attempts. Please wait a few minutes.')
      }
      let email: string
      try {
        email = confirmCode(getDb(), conv.id, data.code)
      } catch (err) {
        asVisitorError(err)
      }
      return { verifiedEmail: maskEmail(email) }
    }),
  )

// A visitor already signed in to your site: the page embedding the widget
// passes an identity token it signed (see README, Integrations).
export const applyIdentity = createServerFn({ method: 'POST' })
  .validator((input: unknown) => ({ token: str(asObject(input), 'token', { max: 1000 }) }))
  .handler(({ data }) =>
    visitorSafe(() => {
      const conv = requireConversation()
      if (!env.identitySecret) throw new VisitorError('Signed-in chat isn’t set up on this site.')
      if (!allowAll([{ key: `identity-ip:${clientIp()}`, max: 30, windowMs: 10 * MINUTE }])) {
        throw new VisitorError('Too many requests. Please wait a moment.')
      }
      let email: string
      try {
        email = verifyIdentityToken(env.identitySecret, data.token)
      } catch (err) {
        asVisitorError(err)
      }
      markVerified(getDb(), conv.id, email, 'identity_token')
      return { verifiedEmail: maskEmail(email) }
    }),
  )


// ws tokens are single-use with a short TTL; if the socket drops before the
// answer arrives, ask ModelRiver for a fresh one (API key stays server-side).
export const reconnectStream = createServerFn({ method: 'POST' })
  .validator((input: unknown) => ({ channelId: uuid(asObject(input), 'channelId') }))
  .handler(({ data }) =>
    visitorSafe(async () => {
      const conv = requireConversation()
      if (conv.last_channel_id !== data.channelId) throw new VisitorError('Unknown stream.')
      if (!allowAll([{ key: `reconnect:${conv.id}`, max: 10, windowMs: MINUTE }])) {
        throw new VisitorError('Too many requests. Please wait a moment.')
      }
      const r = await mr.reconnectChannel(data.channelId)
      const stream: StreamTicket = {
        channelId: r.channel_id,
        websocketUrl: r.websocket_url,
        websocketChannel: r.websocket_channel,
        wsToken: r.ws_token,
      }
      return stream
    }),
  )

const WAITING_NOTE =
  '\n\nThe user has asked for a person and the team has been told. Reply with one or two short sentences ' +
  'saying a team member will reply in this chat soon. Do not answer anything else.'

// The name is the visitor's own text, so it is quoted and labelled as such.
function withVisitorName(context: string, name: string): string {
  if (!name) return context
  return `${context}\n\nThe visitor gave their name as ${JSON.stringify(name)}. You may address them by it.`
}
