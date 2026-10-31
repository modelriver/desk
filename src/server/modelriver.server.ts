import { env, requireApiKey } from './env.server.ts'
import { TtlCache } from './ttl-cache.server.ts'

// Thin wrapper over the ModelRiver public API. All inference, streaming,
// retries, provider fallbacks and conversation history happen in ModelRiver;
// this file only forwards requests with the server-side API key.

export class ModelRiverError extends Error {
  status: number
  code?: string
  constructor(message: string, status: number, code?: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

async function call<T>(method: string, path: string, body?: unknown, timeoutMs = 20_000): Promise<T> {
  const res = await fetch(`${env.modelriverApiUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${requireApiKey()}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    // Non-JSON error page; fall through with the raw status.
  }
  // Provider failures can come back as HTTP 200 with status "error" in the body.
  if (!res.ok || json?.status === 'error') {
    const message = json?.error?.message ?? json?.error ?? json?.message ?? `ModelRiver request failed (${res.status})`
    throw new ModelRiverError(String(message), res.status, json?.error?.code ?? json?.details?.code ?? json?.code)
  }
  return json as T
}

export interface AsyncAccepted {
  channel_id: string
  session_id: string | null
  ws_token: string
  websocket_url: string
  websocket_channel: string
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export function startAsyncRequest(input: {
  sessionId: string | null
  messages: ChatMessage[]
  metadata?: Record<string, string>
}): Promise<AsyncAccepted> {
  return call('POST', '/ai/async', {
    workflow: env.workflow,
    stream: true,
    // Omitted session_id starts a new ModelRiver session; we store the id it returns.
    ...(input.sessionId ? { session_id: input.sessionId } : {}),
    messages: input.messages,
    metadata: input.metadata,
  })
}

// One answer, waited for (POST /v1/ai): for AI drafts in the dashboard, not
// the visitor's chat. The workflow keeps session memory, so it starts a
// session; its id comes back so the caller can delete it.
export async function requestOnce(input: { messages: ChatMessage[]; metadata?: Record<string, string> }): Promise<{ data: unknown; sessionId: string | null }> {
  const res = await call<{ data: unknown; meta?: { session_id?: string | null } }>(
    'POST',
    '/ai',
    { workflow: env.workflow, messages: input.messages, metadata: input.metadata },
    90_000,
  )
  return { data: res.data, sessionId: res.meta?.session_id ?? null }
}

export function reconnectChannel(channelId: string): Promise<AsyncAccepted> {
  return call('POST', '/ai/reconnect', { channel_id: channelId })
}

export interface SessionSummary {
  id: string
  workflow: string
  message_count: number
  last_activity_at: string
  inserted_at: string
  last_message: { role: string; content: string; at: string } | null
}

export interface SessionMessage {
  id: string
  role: 'user' | 'assistant'
  author: 'user' | 'ai' | 'agent'
  author_name?: string | null
  content: string
  created_at: string
}

export interface SessionDetail {
  id: string
  workflow: string
  inserted_at: string
  last_activity_at: string
  messages: SessionMessage[]
  truncated: boolean
}

export function listSessions(page = 1, limit = 50): Promise<{ data: SessionSummary[]; page: number; limit: number }> {
  const qs = new URLSearchParams({ workflow: env.workflow, page: String(page), limit: String(limit) })
  return call('GET', `/sessions?${qs}`)
}

// The API returns at most 100 sessions a page and no total, so read pages
// until one comes back short. Capped so a very large history can't make the
// inbox slow; the newest sessions come first, so the cap drops the oldest.
const SESSION_PAGE_SIZE = 100
const MAX_SESSIONS = 1_000

export async function listRecentSessions(): Promise<SessionSummary[]> {
  const sessions: SessionSummary[] = []
  for (let page = 1; sessions.length < MAX_SESSIONS; page++) {
    const { data } = await listSessions(page, SESSION_PAGE_SIZE)
    sessions.push(...data)
    if (data.length < SESSION_PAGE_SIZE) break
  }
  return sessions
}

// The inbox reads this list often (every open dashboard, every 10 seconds), and
// a long history takes several requests. So one copy is shared for a few
// seconds, and an older one is served at once while a fresh copy loads in the
// background: the page never waits on ModelRiver except on the very first load.
// Every list is the newest MAX_SESSIONS, so `capped` says whether there may be older ones.
const SESSIONS_FRESH_MS = 5_000
const SESSIONS_STALE_MS = 5 * 60_000
let sessionList: { value: SessionSummary[]; at: number } | null = null
let sessionListLoad: Promise<SessionSummary[]> | null = null

export async function recentSessions(now = Date.now()): Promise<{ sessions: SessionSummary[]; capped: boolean }> {
  const age = sessionList ? now - sessionList.at : Infinity
  if (age >= SESSIONS_FRESH_MS) {
    sessionListLoad ??= listRecentSessions()
      .then((value) => {
        sessionList = { value, at: Date.now() }
        return value
      })
      .finally(() => {
        sessionListLoad = null
      })
    // Too old to show (or none yet): wait for the fresh copy.
    if (age >= SESSIONS_STALE_MS) await sessionListLoad
    else sessionListLoad.catch((err) => console.error('[sessions] refreshing the list failed', err))
  }
  const sessions = sessionList!.value
  return { sessions, capped: sessions.length >= MAX_SESSIONS }
}

// A session was added or deleted: the next read refreshes the list (still
// serving this copy meanwhile, so nothing waits).
export function sessionsChanged() {
  if (sessionList) sessionList.at = Math.min(sessionList.at, Date.now() - SESSIONS_FRESH_MS)
}

// The project's usage for a UTC calendar month (GET /v1/usage).
// billable_requests counts AI answers; team replies added to a session don't count.
export interface MonthUsage {
  project_id: string
  month: string
  period_start: string
  period_end: string
  billable_requests: number
  requests: number
  failed_requests: number
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  price: number
  active_sessions: number
  by_day: Array<{ date: string; billable_requests: number; requests: number }>
  updated_at: string
}

export function getUsage(month: string): Promise<MonthUsage> {
  return call('GET', `/usage?${new URLSearchParams({ month })}`)
}

export function getSession(sessionId: string): Promise<SessionDetail> {
  return call('GET', `/sessions/${encodeURIComponent(sessionId)}`)
}

// The widget polls its conversation every few seconds; caching briefly means a
// burst of polls for one session costs at most one ModelRiver call per window.
const sessionCache = new TtlCache<SessionDetail>(2_000)

export function getSessionCached(sessionId: string): Promise<SessionDetail> {
  return sessionCache.get(sessionId, () => getSession(sessionId))
}

// Deletes the session and its history in ModelRiver. Used by the archive cleanup.
export async function deleteSession(sessionId: string): Promise<void> {
  await call('DELETE', `/sessions/${encodeURIComponent(sessionId)}`)
  sessionCache.delete(sessionId)
  sessionsChanged()
}

// Stores a turn in the session without calling a model: user messages while a
// human agent has taken over, and the agent's own replies.
export async function appendSessionMessage(
  sessionId: string,
  message: { role: 'user' | 'assistant'; content: string; author_name?: string },
): Promise<SessionMessage> {
  const saved = await call<SessionMessage>('POST', `/sessions/${encodeURIComponent(sessionId)}/messages`, message)
  sessionCache.delete(sessionId)
  return saved
}

// --- Live updates (ModelRiver's session channel) ---

export interface LiveSubscription {
  session_id: string
  ws_token: string
  websocket_url: string
  websocket_channel: string
  expires_in: number
}

// A single-use socket token for one session's live updates. Only ever hand it
// to someone allowed to see that conversation: the channel carries its messages.
export function subscribeSession(sessionId: string): Promise<LiveSubscription> {
  return call('POST', `/sessions/${encodeURIComponent(sessionId)}/subscribe`)
}

// Tells the session's subscribers about a change that isn't a message (a
// takeover, a hand-back, an archive). Nothing is stored. Best effort: a missed
// signal only delays the update until the next refresh.
export function signalSession(sessionId: string, name: string, data: unknown = null): void {
  // A changed conversation must not be served from the cache to whoever reacts to the signal.
  sessionCache.delete(sessionId)
  call('POST', `/sessions/${encodeURIComponent(sessionId)}/signals`, { name, data }).catch((err) =>
    console.warn('[modelriver] could not send a live update', err),
  )
}
