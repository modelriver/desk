import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useServerFn } from '@tanstack/react-start'
import {
  applyIdentity,
  confirmEmailCode,
  endConversation,
  getConversation,
  requestEmailCode,
  reconnectStream,
  handOffAfterAiError,
  liveConversation,
  reportUnanswered,
  requestHandoff,
  sendMessage,
  startConversation,
  switchToAi,
  CONVERSATION_CLOSED,
  CONVERSATION_NOT_FOUND,
} from '../functions/chat.ts'
import type { HandoffReason, StreamTicket, WidgetMessage } from '../functions/chat.ts'
import type { ModelRiverClient } from '@modelriver/client'
import { citedSlugs, hidePartialMarker, linkCitations } from '../lib/citations.ts'
import { hasHandoffMarker, hasUnsureMarker } from '../lib/handoff.ts'
import { CONVERSATION_UPDATED, LIVE_SAFETY_REFRESH_MS } from '../lib/live.ts'
import type { Source } from '../lib/prompt-core.ts'
import { Markdown } from './Markdown.tsx'
import { HelpBot, type BotMood } from './HelpBot.tsx'
import { Button, Input } from './ui.tsx'
import {
  ArrowUpIcon,
  BookIcon,
  HeadsetIcon,
  LogOutIcon,
  ShieldIcon,
  UserIcon,
  XIcon,
} from './icons.tsx'
import { ActionsMenu, type MenuItem } from './ActionsMenu.tsx'
import { OtpInput } from './OtpInput.tsx'
import { cn } from '../lib/cn.ts'
import { onOpenChat } from '../lib/chat-bus.ts'
import { deleteCookie, readCookie, writeCookie } from '../lib/client-cookie.ts'
import { BusyIcon } from './BusyIcon.tsx'
import { errorMessage } from '../lib/errors.ts'
import { articleUrl } from '../lib/help-path.ts'
import { lockPageScroll, PHONE_QUERY } from '../lib/scroll-lock.ts'

interface UiMessage extends WidgetMessage {
  streaming?: boolean
  error?: string
}

const PENDING_REPLY: UiMessage = { id: 'pending-reply', role: 'assistant', author: 'ai', content: '', streaming: true }

// undefined: not loaded yet. null: no conversation, so ask for a name first.
type Profile = { name: string } | null | undefined

// Account lookups (connectors): who the visitor is verified as, masked, and
// the words that make the assistant check their account.
interface AccountState {
  verifiedEmail: string | null
  verificationExpired: boolean
  lookups: boolean
  canVerify: boolean
  lookupAlways: boolean
  lookupPatterns: string[]
}
const NO_ACCOUNT: AccountState = { verifiedEmail: null, verificationExpired: false, lookups: false, canVerify: false, lookupAlways: false, lookupPatterns: [] }

function wouldLookUp(account: AccountState, text: string): boolean {
  if (!account.lookups || !account.verifiedEmail) return false
  if (account.lookupAlways) return true
  return account.lookupPatterns.some((p) => {
    try {
      return new RegExp(p, 'i').test(text)
    } catch {
      return false
    }
  })
}

// Polling, only while there's no live connection (see the live updates effect).
const HUMAN_POLL_MS = 4000
const AI_POLL_MS = 10_000
const STREAM_TIMEOUT_MS = 120_000

// UI state kept in cookies so a refresh can pick up where the visitor was.
const OPEN_COOKIE = 'desk_widget_open'
const OPEN_MAX_AGE = 24 * 60 * 60
const PENDING_COOKIE = 'desk_pending'
// ModelRiver stops a streaming request after 5 minutes, so the pending cookie
// expires then too: an older answer can't still be running.
const PENDING_MAX_AGE = 5 * 60

// An answer that was streaming when the page was left or refreshed.
interface Pending {
  channelId: string
  question: string
  startedAt: number
}

const loadPending = () => readCookie<Pending>(PENDING_COOKIE)
const savePending = (p: Pending) => writeCookie(PENDING_COOKIE, { ...p, question: p.question.slice(0, 500) }, PENDING_MAX_AGE)
const clearPending = () => deleteCookie(PENDING_COOKIE)

// The final "response" event carries the whole model output; pull text out of
// the common shapes in case no stream_delta events arrived.
function textFromResponse(data: unknown): string {
  if (typeof data === 'string') return data
  if (data && typeof data === 'object') {
    const d = data as any
    return d.content ?? d.text ?? d.message ?? d.choices?.[0]?.message?.content ?? ''
  }
  return ''
}

export function ChatWidget({
  repoUrl,
  brandName,
  embedded = false,
  identityToken = null,
}: {
  repoUrl: string
  brandName: string
  embedded?: boolean
  // Signed by the site embedding the widget for a signed-in visitor (see README, Integrations).
  identityToken?: string | null
}) {
  const [open, setOpen] = useState(embedded)
  const [profile, setProfile] = useState<Profile>(undefined)
  const [messages, setMessages] = useState<UiMessage[]>([])
  const lastReply = messages.findLast((m) => m.role === 'assistant' && !m.streaming && !m.error && m.content)
  const [mode, setMode] = useState<'ai' | 'human'>('ai')
  // Whether the conversation has a ModelRiver session yet (live updates follow it).
  const [hasSession, setHasSession] = useState(false)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [known, setKnown] = useState<Map<string, Source>>(new Map())
  // A question asked before the visitor gave their name; sent right after.
  const [queued, setQueued] = useState<string | null>(null)
  // After "End conversation", or when the team archived the chat: the
  // visitor's name (for the goodbye screen) and who closed it.
  const [ended, setEnded] = useState<{ name: string; byTeam: boolean } | null>(null)
  const [confirmEnd, setConfirmEnd] = useState(false)
  const [retryAt, setRetryAt] = useState(0)
  // When the visitor asked for a person (a local timestamp), until a team
  // member replies or they switch back to the AI. null when not waiting.
  const [waitingSince, setWaitingSince] = useState<number | null>(null)
  // Why: they asked for a person, or the AI couldn't answer.
  const [handoffReason, setHandoffReason] = useState<HandoffReason | null>(null)
  const [account, setAccount] = useState<AccountState>(NO_ACCOUNT)
  // The verify-your-email card: open, and the question to ask again once verified.
  const [verify, setVerify] = useState<{ services: string[]; question: string | null; expired: boolean } | null>(null)
  // The question being sent, until its answer starts streaming.
  const [sending, setSending] = useState<string | null>(null)
  // Whether this conversation was sent the identity token yet.
  const identityApplied = useRef(false)
  const lastName = useRef('')
  const socket = useRef<ModelRiverClient | null>(null)
  const list = useRef<HTMLDivElement>(null)
  // Where the visitor left the message list: null means at the bottom, where
  // new messages stay in view. Kept while the panel is closed, so reopening
  // returns to the same spot.
  const savedScroll = useRef<number | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  // Set when the visitor opens the chat themselves, so the right field gets
  // focus once it renders. A chat restored after a refresh doesn't steal focus.
  const focusWhenReady = useRef(false)
  const [closing, setClosing] = useState(false)
  // Whether the panel plays its entrance (not when it's restored after a reload).
  const [entrance, setEntrance] = useState(true)
  // The launcher fades back in after the panel closes (not on first load).
  const [launcherIn, setLauncherIn] = useState(false)
  // Asked to open before the conversation has loaded: opens once it has.
  const [pendingOpen, setPendingOpen] = useState(false)
  const lastFetchAt = useRef(0)

  const start = useServerFn(startConversation)
  const send = useServerFn(sendMessage)
  const fetchConversation = useServerFn(getConversation)
  const end = useServerFn(endConversation)
  const reconnect = useServerFn(reconnectStream)
  const handoff = useServerFn(requestHandoff)
  const reportAiError = useServerFn(handOffAfterAiError)
  const reportGap = useServerFn(reportUnanswered)
  const toAi = useServerFn(switchToAi)
  const sendIdentity = useServerFn(applyIdentity)

  // True while a message is being sent or an answer is streaming; polls skip
  // then so they never overwrite the in-flight reply.
  const busyRef = useRef(false)
  busyRef.current = busy

  const forgetConversation = useCallback(() => {
    setHasSession(false)
    setProfile(null)
    setMessages([])
    setMode('ai')
    setAccount(NO_ACCOUNT)
    setVerify(null)
    identityApplied.current = false
    setWaitingSince(null)
    setHandoffReason(null)
    clearPending()
  }, [])

  // The server sends how long the visitor has waited, not when they started,
  // so the visitor's clock doesn't matter. Small differences between polls are
  // ignored to keep the timer from jumping.
  const applyWaiting = useCallback((seconds: number | null) => {
    if (seconds === null) return setWaitingSince(null)
    const since = Date.now() - seconds * 1000
    setWaitingSince((prev) => (prev !== null && Math.abs(prev - since) < 5000 ? prev : since))
  }, [])

  // The team archived the conversation while the visitor had it open.
  const closedByTeam = useCallback((name: string) => {
    socket.current?.destroy()
    socket.current = null
    lastName.current = name || lastName.current
    setEnded({ name, byTeam: true })
    setConfirmEnd(false)
    setInput('')
    setQueued(null)
  }, [])

  // `fresh` (after a live update) skips the server's short cache. A refresh
  // asked for while an answer streams runs once it's done.
  const refreshAfterBusy = useRef(false)
  const refresh = useCallback(async (fresh = false) => {
    if (busyRef.current) {
      refreshAfterBusy.current ||= fresh
      return
    }
    lastFetchAt.current = Date.now()
    try {
      const res = await fetchConversation({ data: { fresh } })
      if (busyRef.current) return
      setKnown(new Map(res.articles.map((a) => [a.slug, a])))
      if (!res.conversation) {
        setRetryAt(Date.now() + (res.retryAfterSeconds ?? 0) * 1000)
        if (res.closedFor != null) closedByTeam(res.closedFor)
        return forgetConversation()
      }
      setProfile({ name: res.conversation.name })
      setMode(res.conversation.mode)
      applyWaiting(res.conversation.handoffWaitingSeconds)
      setHandoffReason(res.conversation.handoffReason)
      setHasSession(res.conversation.hasSession)
      setAccount(res.conversation.account)
      // Lapsed: a signed-in visitor's token (if still valid) can verify them again.
      if (res.conversation.account.verificationExpired) identityApplied.current = false
      const history = res.messages
      if (!history) return // history unavailable right now; keep what is shown
      setMessages((prev) => {
        if (prev.some((m) => m.streaming)) return prev
        // ModelRiver logs an answer a moment after it finishes streaming, so a
        // poll can briefly return fewer messages than we already show.
        const shown = prev.filter((m) => !m.error).length
        return history.length >= shown ? history : prev
      })
    } catch {
      // Transient failure: keep what is on screen and try again on the next poll.
    }
  }, [fetchConversation, forgetConversation, applyWaiting, closedByTeam])

  useEffect(() => {
    if (busy || !refreshAfterBusy.current) return
    refreshAfterBusy.current = false
    void refresh(true)
  }, [busy, refresh])

  // Live updates while the chat is open, over ModelRiver's session channel: a
  // team member's replies arrive as messages, and Desk's own changes (taking
  // over, handing back, closing) as a signal; either way the chat reloads.
  // Before the first message there's no session to follow; the next refresh
  // after it (polling meanwhile) reports one.
  const [live, setLive] = useState(false)
  const getLive = useServerFn(liveConversation)
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  const hasProfile = Boolean(profile)
  useEffect(() => {
    if (!open || !hasProfile || !hasSession) return
    let cancelled = false
    let close = () => {}
    void import('@modelriver/client').then(({ subscribeToSession }) => {
      if (cancelled) return
      const sub = subscribeToSession({
        getSubscription: () => getLive(),
        onMessage: () => void refreshRef.current(true),
        onSignal: (signal) => signal.name === CONVERSATION_UPDATED && void refreshRef.current(true),
        onDeleted: () => void refreshRef.current(true),
        // Joined (again): catch up on anything sent while disconnected.
        onLive: () => void refreshRef.current(true),
        onStatus: (status) => setLive(status === 'live'),
      })
      close = sub.close
    })
    return () => {
      cancelled = true
      close()
      setLive(false)
    }
  }, [open, hasProfile, hasSession, getLive])

  // Polls when there's no live connection (none yet, or it dropped), faster
  // once a human is handling the chat. While live, a slow refresh is a safety net.
  useEffect(() => {
    if (!open || !profile) return
    const every = live ? LIVE_SAFETY_REFRESH_MS : mode === 'human' ? HUMAN_POLL_MS : AI_POLL_MS
    const timer = setInterval(() => void refresh(), every)
    return () => clearInterval(timer)
  }, [open, profile, mode, refresh, live])

  // Placed before the browser paints, so opening the chat shows the bottom (or
  // the visitor's last spot) at once instead of scrolling down from the top.
  // Runs again for new messages and when the waiting card changes the list's height.
  const handoffShown = mode === 'human' && waitingSince !== null
  useLayoutEffect(() => {
    const el = list.current
    if (!el) return
    el.scrollTop = savedScroll.current ?? el.scrollHeight
  }, [open, profile, messages, mode, handoffShown, confirmEnd, sending])
  const onListScroll = () => {
    const el = list.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 32
    savedScroll.current = atBottom ? null : el.scrollTop
  }

  useEffect(() => () => socket.current?.destroy(), [])

  // On a phone the open chat fills the screen: the page behind it stays put
  // instead of scrolling along (and showing its scrollbar) under the chat.
  useEffect(() => {
    if (!open || embedded || !window.matchMedia(PHONE_QUERY).matches) return
    return lockPageScroll()
  }, [open, embedded])

  // Set while the page is being refreshed or left. The browser closes the
  // websocket then, which looks like a dropped connection; reacting to it
  // (retrying, clearing the pending cookie) would stop the next page load
  // from resuming the answer.
  const leaving = useRef(false)
  useEffect(() => {
    const mark = () => {
      leaving.current = true
    }
    const unmark = (e: PageTransitionEvent) => {
      if (e.persisted) leaving.current = false // restored from the back/forward cache
    }
    window.addEventListener('pagehide', mark)
    window.addEventListener('beforeunload', mark)
    window.addEventListener('pageshow', unmark)
    return () => {
      window.removeEventListener('pagehide', mark)
      window.removeEventListener('beforeunload', mark)
      window.removeEventListener('pageshow', unmark)
    }
  }, [])

  const updateMessage = (id: string, patch: (m: UiMessage) => Partial<UiMessage>) =>
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch(m) } : m)))

  // Stream the answer over ModelRiver's websocket using the official client SDK.
  const stream = useCallback(
    // resumed: joining an answer that was already streaming (after a refresh or
    // a dropped connection). Text sent before we joined is gone, so deltas
    // are ignored and the full answer comes from stream_done / response.
    // question: what the visitor asked, for the team's Insights if the answer falls short.
    async (ticket: StreamTicket, messageId: string, opts: { retried?: boolean; resumed?: boolean; question?: string } = {}) => {
      const { ModelRiverClient } = await import('@modelriver/client')
      const client = new ModelRiverClient({ persist: false })
      socket.current?.destroy()
      socket.current = client
      let finished = false
      const timeout = setTimeout(() => fail(), STREAM_TIMEOUT_MS)

      const stop = () => {
        finished = true
        clearTimeout(timeout)
        client.destroy()
        if (socket.current === client) socket.current = null
      }
      const finish = (patch: (m: UiMessage) => Partial<UiMessage>) => {
        if (finished) return
        stop()
        clearPending()
        updateMessage(messageId, (m) => ({ ...patch(m), streaming: false }))
        setBusy(false)
      }
      // The answer failed (a model error, a timeout or a lost connection):
      // rather than show an error, pass the chat to the team.
      function fail() {
        if (finished) return
        finish(() => ({}))
        onAiFailure.current(messageId, opts.question)
      }
      // ws tokens are single-use, so a dropped connection needs a fresh one from our server.
      const retry = async () => {
        if (finished || leaving.current) return
        if (opts.retried) return fail()
        stop()
        try {
          const fresh = await reconnect({ data: { channelId: ticket.channelId } })
          await stream(fresh, messageId, { retried: true, resumed: true, question: opts.question })
        } catch {
          if (leaving.current) return
          clearPending()
          updateMessage(messageId, () => ({ streaming: false }))
          setBusy(false)
          onAiFailure.current(messageId, opts.question)
        }
      }

      let answer = ''
      client.on('stream_delta', (_chunk, text) => {
        answer = text
        if (!opts.resumed) updateMessage(messageId, () => ({ content: text }))
      })
      client.on('stream_done', (done) => {
        if (done.accumulated_text) {
          answer = done.accumulated_text
          updateMessage(messageId, () => ({ content: done.accumulated_text! }))
        }
      })
      client.on('response', (payload) => {
        if (payload.status === 'error') return fail()
        const fallback = textFromResponse(payload.data ?? payload.content)
        finish((m) => ({ content: m.content || fallback }))
        // The AI recognised a request for a person and ended its reply with [[handoff]].
        if (hasHandoffMarker(answer || fallback)) onHandoffMarker.current()
        // The articles didn't cover it: let the team know what to write next.
        if (opts.question && hasUnsureMarker(answer || fallback)) {
          void reportGap({ data: { question: opts.question } }).catch(() => {})
        }
      })
      client.on('stream_error', () => fail())
      client.on('channel_error', () => void retry())
      client.on('error', () => void retry())

      client.connect({
        channelId: ticket.channelId,
        wsToken: ticket.wsToken,
        websocketUrl: ticket.websocketUrl,
        websocketChannel: ticket.websocketChannel,
      })
    },
    [reconnect],
  )

  // Ask for a person: from the chat menu, or when the AI's reply carries the
  // handoff marker.
  const askForPerson = async () => {
    setError(null)
    try {
      const res = await handoff()
      setMode(res.mode)
      applyWaiting(res.handoffWaitingSeconds)
      setHandoffReason(res.handoffReason)
    } catch (err) {
      setError(errorMessage(err, 'Couldn’t reach the team. Try again.'))
    }
  }
  const onHandoffMarker = useRef(askForPerson)
  onHandoffMarker.current = askForPerson

  // An answer failed while streaming. The team gets the chat (ModelRiver has
  // already stored the question in the session); an empty reply bubble is
  // removed, and a partly written one is kept as it is. Only when there's
  // nothing to hand over (no session yet) does the visitor see a retry message.
  const handOffAfterFailure = async (messageId: string, question?: string) => {
    try {
      const res = await reportAiError({ data: { question: question ?? null } })
      if (res.handedOff) {
        setMessages((prev) => prev.filter((m) => m.id !== messageId || m.content.trim()))
        setMode('human')
        applyWaiting(res.handoffWaitingSeconds)
        setHandoffReason(res.handoffReason)
        return
      }
    } catch {
      // Fall through to the retry message.
    }
    updateMessage(messageId, () => ({ error: 'Our assistant couldn’t answer just now. Please try again in a moment.' }))
  }
  const onAiFailure = useRef(handOffAfterFailure)
  onAiFailure.current = handOffAfterFailure

  const backToAi = async () => {
    setError(null)
    try {
      const res = await toAi()
      setMode(res.mode)
      setWaitingSince(null)
      setHandoffReason(null)
      inputRef.current?.focus()
    } catch (err) {
      setError(errorMessage(err, 'Couldn’t switch back to the AI assistant. Try again.'))
    }
  }

  // After a refresh: show the history, then rejoin the answer that was still
  // streaming. If it already finished, ModelRiver won't issue a new token and
  // the answer is in the session history instead.
  const resume = useCallback(
    async (pending: Pending) => {
      busyRef.current = true
      setBusy(true)
      try {
        const res = await fetchConversation()
        setKnown(new Map(res.articles.map((a) => [a.slug, a])))
        if (!res.conversation) {
          if (res.closedFor != null) closedByTeam(res.closedFor)
          forgetConversation()
          busyRef.current = false
          setBusy(false)
          return
        }
        setProfile({ name: res.conversation.name })
        setMode(res.conversation.mode)
        applyWaiting(res.conversation.handoffWaitingSeconds)
        setHandoffReason(res.conversation.handoffReason)
        setHasSession(res.conversation.hasSession)
        // ModelRiver logs a turn when its answer completes, so the pending
        // question isn't in this history yet.
        if (res.messages) setMessages(res.messages)
      } catch {
        // Keep going: the stream can still be rejoined.
      }
      try {
        const ticket = await reconnect({ data: { channelId: pending.channelId } })
        const replyId = `reply-${Date.now()}`
        setMessages((prev) => [
          ...prev,
          { id: `local-${pending.startedAt}`, role: 'user', author: 'user', content: pending.question },
          { id: replyId, role: 'assistant', author: 'ai', content: '', streaming: true },
        ])
        void stream(ticket, replyId, { resumed: true, question: pending.question })
      } catch {
        clearPending()
        busyRef.current = false
        setBusy(false)
        void refresh()
        // The finished answer can take a moment to be logged.
        setTimeout(() => void refresh(), 3000)
      }
    },
    [fetchConversation, forgetConversation, applyWaiting, closedByTeam, reconnect, stream, refresh],
  )

  // Load the conversation when the chat opens, resuming an answer that was
  // still streaming when the page was refreshed. Skipped when it was just
  // loaded (the launcher loads it before opening).
  useEffect(() => {
    if (!open || busyRef.current) return
    const pending = loadPending()
    if (pending && Date.now() - pending.startedAt < PENDING_MAX_AGE * 1000) void resume(pending)
    else if (Date.now() - lastFetchAt.current > 2000) void refresh()
  }, [open, refresh, resume])
  useEffect(() => {
    if (embedded || !restoredOpen.current) return
    if (open) writeCookie(OPEN_COOKIE, true, OPEN_MAX_AGE)
    else deleteCookie(OPEN_COOKIE)
  }, [open, embedded])

  const sendText = async (raw: string) => {
    const text = raw.trim()
    if (!text || busyRef.current) return
    // No conversation yet: ask for a name first, then send this question.
    if (!profile) {
      setQueued(text)
      setInput('')
      return
    }
    busyRef.current = true
    setBusy(true)
    setError(null)
    setInput('')
    // Sending a message brings the conversation back to the bottom.
    savedScroll.current = null
    const localId = `local-${Date.now()}`
    setMessages((prev) => [...prev, { id: localId, role: 'user', author: 'user', content: text }])
    setSending(text)
    try {
      const res = await send({ data: { text } })
      setSending(null)
      // The question needs their account and they haven't verified yet.
      if (res.verify) {
        setVerify({ services: res.verify.services, question: text, expired: res.verify.expired })
        if (res.verify.expired) identityApplied.current = false
      }
      if (res.handoff) {
        // The server recognised a request for a person, or the AI couldn't
        // answer, and passed the chat to the team.
        setMode('human')
        setWaitingSince((prev) => prev ?? Date.now())
        setHandoffReason((prev) => prev ?? res.handoffReason ?? 'asked')
      } else {
        setMode(res.mode)
      }
      if (res.mode === 'human' || !res.stream) {
        setBusy(false)
        return
      }
      setKnown((prev) => new Map([...prev, ...res.sources.map((s) => [s.slug, s] as const)]))
      const replyId = `reply-${Date.now()}`
      setMessages((prev) => [...prev, { id: replyId, role: 'assistant', author: 'ai', content: '', streaming: true }])
      savePending({ channelId: res.stream.channelId, question: text, startedAt: Date.now() })
      void stream(res.stream, replyId, { question: text })
    } catch (err) {
      setSending(null)
      setBusy(false)
      busyRef.current = false
      if (err instanceof Error && err.message === CONVERSATION_CLOSED) {
        closedByTeam(profile.name)
        forgetConversation()
        return
      }
      // The conversation expired or was removed: start over, keeping the question.
      if (err instanceof Error && err.message === CONVERSATION_NOT_FOUND) {
        forgetConversation()
        setQueued(text)
        return
      }
      setMessages((prev) => prev.filter((m) => m.id !== localId))
      setInput(text)
      setError(errorMessage(err, 'Could not send your message.'))
    }
  }

  const startChat = async (name: string) => {
    setError(null)
    setBusy(true)
    try {
      const res = await start({ data: { name } })
      if (!res.started) {
        setRetryAt(Date.now() + res.retryAfterSeconds * 1000)
        return
      }
      focusWhenReady.current = true
      lastName.current = res.name
      setProfile({ name: res.name })
      setMessages([])
      setMode('ai')
    } catch (err) {
      setError(errorMessage(err, 'Could not start the chat.'))
    } finally {
      setBusy(false)
    }
  }

  const endChat = async () => {
    setError(null)
    setBusy(true)
    try {
      const res = await end()
      socket.current?.destroy()
      socket.current = null
      lastName.current = profile?.name ?? lastName.current
      setEnded({ name: profile?.name ?? '', byTeam: false })
      setConfirmEnd(false)
      setRetryAt(Date.now() + res.retryAfterSeconds * 1000)
      setInput('')
      setQueued(null)
      forgetConversation()
    } catch (err) {
      setError(errorMessage(err, 'Couldn’t end the conversation. Try again.'))
    } finally {
      setBusy(false)
    }
  }

  // A visitor signed in on the site embedding the widget: verify them with
  // the identity token it passed, once per conversation.
  useEffect(() => {
    if (!identityToken || !profile || identityApplied.current || account.verifiedEmail) return
    identityApplied.current = true
    sendIdentity({ data: { token: identityToken } })
      .then((res) => setAccount((prev) => ({ ...prev, verifiedEmail: res.verifiedEmail })))
      .catch((err) => console.warn('[chat] the identity token was not accepted', err))
  }, [identityToken, profile, account.verifiedEmail, sendIdentity])

  const verified = (email: string) => {
    const question = verify?.question ?? null
    setAccount((prev) => ({ ...prev, verifiedEmail: email }))
    setVerify(null)
    // Ask again, now that the assistant can see their account.
    if (question) setQueued(question)
  }

  // Send a question that was waiting for the visitor's name.
  useEffect(() => {
    if (!profile || !queued || busy) return
    setQueued(null)
    void sendText(queued)
    // sendText reads the latest state when it runs; it isn't a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, queued, busy])

  // Finishes closing even if animationend never fires (background tabs don't
  // run animations).
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const finishClose = () => {
    clearTimeout(closeTimer.current)
    setClosing(false)
    setOpen(false)
    setLauncherIn(true)
  }

  // Opening waits for the conversation to load, so the panel appears with its
  // content instead of a spinner that's swapped out a moment later.
  const profileRef = useRef(profile)
  profileRef.current = profile
  const requestOpen = useCallback(
    ({ animate = true, focus = true }: { animate?: boolean; focus?: boolean } = {}) => {
      clearTimeout(closeTimer.current)
      setClosing(false)
      setLauncherIn(false)
      setEntrance(animate)
      if (focus) focusWhenReady.current = true
      if (profileRef.current !== undefined) return setOpen(true)
      setPendingOpen(true)
      // Unless hovering the launcher already started loading it.
      if (Date.now() - lastFetchAt.current > 2000) void refresh()
    },
    [refresh],
  )
  useEffect(() => {
    if (!pendingOpen) return
    if (profile !== undefined) {
      setPendingOpen(false)
      setOpen(true)
      return
    }
    // A slow network: open anyway and show the spinner.
    const timer = setTimeout(() => {
      setPendingOpen(false)
      setOpen(true)
    }, 800)
    return () => clearTimeout(timer)
  }, [pendingOpen, profile])
  const openChatPanel = () => requestOpen()

  // Start loading as soon as someone heads for the launcher.
  const prefetch = () => {
    if (profileRef.current === undefined && Date.now() - lastFetchAt.current > 5000) void refresh()
  }

  // Reopen the chat after a reload if it was open: straight away, without the
  // entrance, and with its content. Read after mount so the server-rendered
  // HTML (always closed) matches the first client render.
  const restoredOpen = useRef(false)
  useEffect(() => {
    if (embedded) return
    if (readCookie<boolean>(OPEN_COOKIE)) requestOpen({ animate: false, focus: false })
    restoredOpen.current = true
  }, [embedded, requestOpen])

  // Focus the name field (new chat) or the message box once it is on screen.
  useEffect(() => {
    if (!open || !focusWhenReady.current || profile === undefined) return
    focusWhenReady.current = false
    if (profile === null) nameRef.current?.focus()
    else inputRef.current?.focus()
  }, [open, profile])

  // The panel plays a short exit transition, then unmounts. Visitors who ask
  // for reduced motion get no transition, so close straight away.
  const closeChatPanel = () => {
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (reduced) return finishClose()
    setClosing(true)
    clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(finishClose, 200)
  }

  // Other parts of the page (the hero composer, "Ask a question" buttons)
  // open the chat through a window event, optionally with a question to send.
  useEffect(
    () =>
      onOpenChat((text) => {
        if (text) setQueued(text)
        requestOpen()
      }),
    [requestOpen],
  )

  if (!open) {
    return (
      <Button
        size="none"
        onClick={openChatPanel}
        onPointerEnter={prefetch}
        onPointerDown={prefetch}
        onFocus={prefetch}
        aria-busy={pendingOpen || undefined}
        data-motion={launcherIn ? '' : undefined}
        className={cn('fixed right-5 bottom-5 z-50 size-14 rounded-full', launcherIn && 'launcher-in')}
        aria-label="Open support chat"
      >
        <HelpBot size={36} inverted />
      </Button>
    )
  }

  const waiting = mode === 'human' && waitingSince !== null
  // The bot in the header shows what's happening right now. Once a person has
  // the chat (waiting for one, or talking with one), the bot sleeps.
  const botMood: BotMood = ended
    ? ended.byTeam
      ? 'idle'
      : 'happy'
    : mode === 'human'
      ? 'sleepy'
      : messages.some((m) => m.streaming) || (busy && mode === 'ai' && !!profile)
        ? 'thinking'
        : input.trim()
          ? 'listening'
          : 'idle'
  const status = waiting
    ? { dot: 'bg-primary', text: 'Waiting for a team member' }
    : sending !== null && mode === 'ai' && wouldLookUp(account, sending)
      ? { dot: 'bg-primary', text: 'Checking your account…' }
    : mode === 'human'
      ? { dot: 'bg-success', text: 'A team member is in this chat' }
      : // Green: the assistant is online.
        { dot: 'bg-success', text: 'Answers from our help articles' }

  const menuItems: MenuItem[] = []
  if (waiting) {
    // Only while nobody has replied yet: once a team member is in the chat,
    // it stays with them until they hand it back.
    menuItems.push({ label: 'Switch to AI assistant', icon: <HelpBot size={16} animated={false} />, onSelect: () => void backToAi() })
  } else if (mode === 'ai' && messages.length > 0) {
    // The team works from the conversation's history, so there has to be a message first.
    menuItems.push({ label: 'Talk to a person', icon: <HeadsetIcon size={15} />, onSelect: () => void askForPerson() })
  }
  if (account.canVerify && !account.verifiedEmail && !verify) {
    menuItems.push({ label: 'Verify your email', icon: <ShieldIcon size={15} />, onSelect: () => setVerify({ services: [], question: null, expired: false }) })
  }
  menuItems.push({ label: 'End conversation', icon: <LogOutIcon size={15} />, destructive: true, onSelect: () => setConfirmEnd(true) })

  return (
    <section
      aria-label="Support chat"
      // The one place motion is allowed (see styles.css): open/close transition.
      data-motion={embedded ? undefined : ''}
      onAnimationEnd={(e) => {
        if (e.target === e.currentTarget && closing) finishClose()
      }}
      className={cn(
        'flex flex-col overflow-hidden bg-card',
        !embedded && (closing ? 'chat-leave' : entrance && 'chat-enter'),
        embedded
          ? 'h-dvh w-full'
          : // Full screen on a phone; a floating panel from `sm` up.
            'fixed right-5 bottom-5 z-50 h-[min(640px,calc(100dvh-2.5rem))] w-[min(400px,calc(100vw-2.5rem))] rounded-2xl border border-border max-sm:inset-0 max-sm:h-dvh max-sm:w-full max-sm:rounded-none max-sm:border-0',
      )}
    >
      <header className="flex items-center gap-3 border-b border-border px-4 py-3">
        {/* Always the bot, never the logo: its mood shows what the assistant is doing, and a wide logo would crowd the name. */}
        <HelpBot mood={botMood} size={32} label={`Help bot, ${botMood}`} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{brandName}</p>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground" aria-live="polite">
            <span className={cn('size-1.5 rounded-full', status.dot)} aria-hidden="true" />
            {status.text}
          </p>
        </div>
        {profile && !ended && (
          <ActionsMenu label="Conversation options" items={menuItems} />
        )}
        {!embedded && (
          <Button variant="ghost" size="icon-sm" onClick={closeChatPanel} aria-label="Close chat">
            <XIcon />
          </Button>
        )}
      </header>

      {profile === undefined ? (
        <div className="grid flex-1 place-items-center text-muted-foreground">
          <BusyIcon busy size={18} />
        </div>
      ) : ended !== null ? (
        <EndedScreen
          name={ended.name}
          byTeam={ended.byTeam}
          retryAt={retryAt}
          onStartNew={() => {
            setEnded(null)
            focusWhenReady.current = true
          }}
        />
      ) : profile === null ? (
        <NameStep
          busy={busy}
          error={error}
          queued={queued}
          onStart={startChat}
          inputRef={nameRef}
          retryAt={retryAt}
          defaultName={lastName.current}
        />
      ) : (
        <>
          {/* Announces each finished reply once; the list itself isn't a live
              region, or screen readers would read every streamed word. */}
          <p className="sr-only" aria-live="polite">
            {lastReply ? `${lastReply.author === 'agent' ? lastReply.authorName || 'Team' : 'Assistant'}: ${lastReply.content}` : ''}
          </p>
          <div ref={list} onScroll={onListScroll} className="flex-1 space-y-5 overflow-y-auto overscroll-contain px-4 py-5">
            {messages.length === 0 && (
              <div className="flex h-full flex-col justify-end pb-2">
                <HelpBot body="figure" mood={input.trim() ? 'listening' : 'idle'} size={84} className="-ml-2 mb-3" />
                <p className="font-serif text-xl leading-snug">Hi {profile.name}, what can we help with?</p>
                <p className="mt-2 text-sm text-muted-foreground">
                  Answers come from our help articles and link to them. If you need a person, say so and our team can join
                  this chat.
                </p>
              </div>
            )}
            {messages.map((m) => (
              <ChatMessage key={m.id} message={m} known={known} />
            ))}
            {/* The question is on its way: show the bot at work until its reply bubble takes over. */}
            {sending !== null && mode === 'ai' && <ChatMessage message={PENDING_REPLY} known={known} />}
          </div>

          {error && (
            <p role="alert" className="mx-4 mb-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}

          {!confirmEnd && waiting && <WaitingCard since={waitingSince} reason={handoffReason ?? 'asked'} onBackToAi={() => void backToAi()} />}

          {!confirmEnd && !waiting && verify && !account.verifiedEmail && (
            <VerifyCard services={verify.services} expired={verify.expired} onVerified={verified} onDismiss={() => setVerify(null)} />
          )}

          {confirmEnd ? (
            <div role="alertdialog" aria-label="End conversation" className="mx-3 mb-2 rounded-xl border border-border bg-background p-3.5">
              <p className="text-sm font-medium">End this conversation?</p>
              <p className="mt-1 text-sm text-muted-foreground">
                You won’t be able to continue it. Our team can still read it.
              </p>
              <div className="mt-3 flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => setConfirmEnd(false)} autoFocus>
                  Keep chatting
                </Button>
                <Button variant="outline" size="sm" className="text-destructive" disabled={busy} onClick={() => void endChat()}>
                  <BusyIcon busy={busy} size={14} />
                  End conversation
                </Button>
              </div>
            </div>
          ) : (
          <form
            className="px-3 pb-2"
            onSubmit={(e) => {
              e.preventDefault()
              void sendText(input)
            }}
          >
            <div className="flex items-end gap-2 rounded-xl border border-input bg-background p-1.5 pl-3 focus-within:border-ring">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    e.currentTarget.form?.requestSubmit()
                  }
                }}
                placeholder={waiting ? 'Add details for our team…' : mode === 'human' ? 'Reply to the team…' : 'Ask a question…'}
                rows={1}
                maxLength={4000}
                aria-label="Message"
                className="max-h-32 min-h-8 flex-1 resize-none bg-transparent py-1.5 text-base outline-none placeholder:text-muted-foreground [field-sizing:content] sm:text-sm"
              />
              <Button type="submit" size="icon-sm" className="rounded-lg" disabled={busy || !input.trim()} aria-label="Send message">
                <BusyIcon busy={busy} size={15} idle={<ArrowUpIcon size={16} />} />
              </Button>
            </div>
          </form>
          )}
        </>
      )}
      <footer className="pb-2.5 text-center text-[11px] text-muted-foreground">
        <a href={repoUrl} target="_blank" rel="noopener noreferrer" className="hover:text-foreground">
          Powered by Desk
        </a>
      </footer>
    </section>
  )
}

// Proving an email address so the assistant can look up the visitor's own
// orders, billing or bookings: a 6-digit code goes to that address.
function VerifyCard({
  services,
  expired,
  onVerified,
  onDismiss,
}: {
  services: string[]
  // They had verified, but it lapsed.
  expired: boolean
  onVerified: (maskedEmail: string) => void
  onDismiss: () => void
}) {
  const requestCode = useServerFn(requestEmailCode)
  const confirm = useServerFn(confirmEmailCode)
  const [email, setEmail] = useState('')
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // A new key clears the code boxes after a wrong code.
  const [attempt, setAttempt] = useState(0)

  const send = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await requestCode({ data: { email } })
      setSentTo(res.sentTo)
    } catch (err) {
      setError(errorMessage(err, 'Couldn’t send the code.'))
    } finally {
      setBusy(false)
    }
  }

  const check = async (code: string) => {
    setBusy(true)
    setError(null)
    try {
      const res = await confirm({ data: { code } })
      onVerified(res.verifiedEmail)
    } catch (err) {
      setError(errorMessage(err, 'Couldn’t check the code.'))
      setAttempt((a) => a + 1)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div role="region" aria-label="Verify your email" className="mx-3 mb-2 rounded-xl border border-border bg-background p-3.5">
      <div className="flex items-start gap-2">
        <ShieldIcon size={16} className="mt-0.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{expired ? 'Verify your email again' : 'Verify your email'}</p>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {sentTo
              ? `Enter the 6-digit code we sent to ${sentTo}.`
              : expired
                ? 'For your security, verification only lasts a while. Verify again so we can check your account.'
                : `So we can check your ${services.length ? services.join(' and ') : 'account'} details. Use the email you ordered or signed up with.`}
          </p>
        </div>
        <Button variant="ghost" size="icon-sm" className="-mt-1 -mr-1" onClick={onDismiss} aria-label="Not now">
          <XIcon size={15} />
        </Button>
      </div>
      {sentTo ? (
        <div className="mt-3 grid gap-2">
          <OtpInput key={attempt} label="Verification code" autoFocus disabled={busy} invalid={!!error} onComplete={(code) => void check(code)} />
          <button
            type="button"
            className="justify-self-center text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            disabled={busy}
            onClick={() => {
              setSentTo(null)
              setError(null)
            }}
          >
            Use a different email or send a new code
          </button>
        </div>
      ) : (
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (email.trim()) void send()
          }}
        >
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            placeholder="you@example.com"
            aria-label="Your email"
            maxLength={254}
            required
            className="h-8"
          />
          <Button type="submit" size="sm" disabled={busy || !email.trim()}>
            <BusyIcon busy={busy} size={14} />
            Send code
          </Button>
        </form>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}

// First step of a new conversation: the visitor's name, so the team knows who
// they're talking to.
function NameStep({
  busy,
  error,
  queued,
  onStart,
  inputRef,
  retryAt,
  defaultName,
}: {
  busy: boolean
  error: string | null
  queued: string | null
  onStart: (name: string) => void
  inputRef: RefObject<HTMLInputElement | null>
  retryAt: number
  defaultName: string
}) {
  const [name, setName] = useState(defaultName)
  const wait = useSecondsLeft(retryAt)
  return (
    <form
      className="flex flex-1 flex-col justify-end gap-4 px-4 pt-5 pb-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (name.trim()) onStart(name.trim())
      }}
    >
      <div>
        <HelpBot body="figure" size={84} className="-ml-2 mb-3" />
        <p className="font-serif text-xl leading-snug">Hi, what can we help with?</p>
        <p className="mt-2 text-sm text-muted-foreground">
          Tell us your name first, so our team knows who they’re talking to if they join.
        </p>
      </div>
      {queued && (
        <p className="rounded-lg bg-muted px-3 py-2 text-sm">
          <span className="text-muted-foreground">Your question: </span>
          {queued.length > 160 ? `${queued.slice(0, 160)}…` : queued}
        </p>
      )}
      <label className="grid gap-1.5 text-sm font-medium">
        Your name
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={60}
          autoComplete="given-name"
          ref={inputRef}
          required
          placeholder="For example: Sam"
        />
      </label>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" disabled={busy || !name.trim() || wait > 0} className="w-full">
        <BusyIcon busy={busy} size={15} />
        {wait > 0 ? `You can start a new chat in ${formatWait(wait)}` : queued ? 'Start chat and ask' : 'Start chat'}
      </Button>
    </form>
  )
}

// Shown after "End conversation". Starting another chat is paced by the
// server; the button counts down until it's allowed.
function EndedScreen({
  name,
  byTeam,
  retryAt,
  onStartNew,
}: {
  name: string
  byTeam: boolean
  retryAt: number
  onStartNew: () => void
}) {
  const wait = useSecondsLeft(retryAt)
  return (
    <div className="flex flex-1 flex-col justify-end gap-4 px-4 pt-5 pb-3">
      <HelpBot body="figure" mood={byTeam ? 'idle' : 'happy'} size={84} className="-ml-2 -mb-1" />
      {byTeam ? (
        <div>
          <p className="font-serif text-xl leading-snug">Our team closed this conversation.</p>
          <p className="mt-2 text-sm text-muted-foreground">
            {name ? `Thanks for getting in touch, ${name}. ` : 'Thanks for getting in touch. '}
            If you still need help, start a new conversation and we’ll pick it up from there.
          </p>
        </div>
      ) : (
        <div>
          <p className="font-serif text-xl leading-snug">Conversation ended{name ? `. Thanks, ${name}` : ''}.</p>
          <p className="mt-2 text-sm text-muted-foreground">
            Our team can still read it if they need to follow up on something. You can start a new chat any time.
          </p>
        </div>
      )}
      <Button variant="outline" disabled={wait > 0} onClick={onStartNew} className="w-full">
        {wait > 0 ? `Start a new conversation in ${formatWait(wait)}` : 'Start a new conversation'}
      </Button>
      {wait > 0 && (
        <p className="text-center text-xs text-muted-foreground">
          To keep the chat available for everyone, new conversations are paced after one ends.
        </p>
      )}
    </div>
  )
}

// Shown above the composer while the visitor waits for a person, with how
// long they've waited and a way back to the AI.
function WaitingCard({ since, reason, onBackToAi }: { since: number; reason: HandoffReason; onBackToAi: () => void }) {
  const elapsed = useSecondsSince(since)
  // After a few minutes, say plainly that it may take a while.
  const slow = elapsed >= 180
  return (
    <div role="status" className="mx-3 mb-2 rounded-xl border border-primary/30 bg-primary/5 p-3.5">
      <div className="flex items-center gap-2.5">
        {/* The assistant has stepped aside for the team. */}
        <HelpBot mood="sleepy" size={28} />
        <p className="min-w-0 flex-1 text-sm font-medium">Connecting you with our team</p>
        {/* Ticks every second, so it's hidden from screen readers to avoid constant announcements. */}
        <span className="font-mono text-xs text-muted-foreground tabular-nums" aria-hidden="true" title="Time waiting">
          {formatElapsed(elapsed)}
        </span>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">
        {slow
          ? 'Everyone may be busy right now. Your place is kept: leave this chat open or come back later, and the reply will be here.'
          : reason === 'ai_error'
            ? 'Our assistant couldn’t answer that one, so we’ve passed your question to the team. Someone will reply right here.'
            : 'We’ve let them know you’d like to talk to a person. Someone will reply right here, and you can add details below while you wait.'}
      </p>
      <button
        type="button"
        onClick={onBackToAi}
        className="mt-2.5 text-sm font-medium text-primary underline-offset-4 hover:underline"
      >
        Go back to the AI assistant
      </button>
    </div>
  )
}

// Whole seconds since `since` (a timestamp), updating once a second.
function useSecondsSince(since: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [since])
  return Math.max(0, Math.floor((now - since) / 1000))
}

// "0:42", "12:05" or "1:02:05".
function formatElapsed(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = String(seconds % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

// Whole seconds until `until` (a timestamp), updating once a second.
function useSecondsLeft(until: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (until <= Date.now()) return
    setNow(Date.now())
    const timer = setInterval(() => {
      setNow(Date.now())
      if (Date.now() >= until) clearInterval(timer)
    }, 1000)
    return () => clearInterval(timer)
  }, [until])
  return Math.max(0, Math.ceil((until - now) / 1000))
}

// "45 s" or "2:05".
function formatWait(seconds: number): string {
  if (seconds < 60) return `${seconds} s`
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function ChatMessage({ message, known }: { message: UiMessage; known: Map<string, Source> }) {
  const sources = useMemo(
    () => (message.author === 'ai' && !message.streaming ? citedSlugs(message.content, known) : []),
    [message, known],
  )

  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <p className="max-w-[85%] rounded-2xl rounded-br-md bg-muted px-3.5 py-2 text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">
          {message.content}
        </p>
      </div>
    )
  }

  const text = linkCitations(message.streaming ? hidePartialMarker(message.content) : message.content, known)
  const isAgent = message.author === 'agent'

  return (
    <div className="flex gap-3">
      {isAgent ? (
        <span className="grid size-6 shrink-0 place-items-center rounded-full bg-success/15 text-success" aria-hidden="true">
          <UserIcon size={13} />
        </span>
      ) : message.streaming ? (
        <HelpBot mood="thinking" size={26} />
      ) : (
        <HelpBot size={26} animated={false} />
      )}
      <div className="min-w-0 flex-1 pt-0.5">
        {isAgent && (
          <p className="mb-1 text-xs font-medium text-muted-foreground">{message.authorName || 'Support team'}, from our team</p>
        )}
        {text ? <Markdown source={text} className="prose-chat" chat /> : message.streaming ? <TypingDots /> : null}
        {message.error && <p className="mt-2 text-sm text-destructive">{message.error}</p>}
        {sources.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {sources.map((s) => (
              <a
                key={s.slug}
                href={articleUrl(s.path)}
                className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground hover:border-primary hover:text-foreground"
              >
                <BookIcon size={12} />
                {s.title}
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function TypingDots() {
  return (
    <span className="inline-flex h-6 items-center gap-1" role="status" aria-label="Writing an answer">
      {[0, 1, 2].map((i) => (
        // data-motion opts the dots out of the no-motion rule (see styles.css).
        <span key={i} data-motion="" className="typing-dot size-1.5 rounded-full bg-muted-foreground" />
      ))}
    </span>
  )
}
