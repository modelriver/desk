import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { agentReply, archiveConversation, getTranscript, liveTranscript, restoreConversation, setConversationMode } from '../../functions/dashboard.ts'
import { Markdown } from '../../components/Markdown.tsx'
import { HelpBot } from '../../components/HelpBot.tsx'
import { LoadError } from '../../components/LoadError.tsx'
import { ArchiveIcon, ArrowLeftIcon, ArrowUpIcon, HeadsetIcon, LockIcon, ShieldIcon, UserIcon } from '../../components/icons.tsx'
import { Badge, Button, Notice } from '../../components/ui.tsx'
import { linkCitations } from '../../lib/citations.ts'
import { cn } from '../../lib/cn.ts'
import { RelativeTime } from '../../components/RelativeTime.tsx'
import { ConfirmPopover } from '../../components/ConfirmPopover.tsx'
import { HandlerBadge } from '../../components/ConversationList.tsx'
import { Tooltip } from '../../components/Tooltip.tsx'
import { CONVERSATION_UPDATED, LIVE_SAFETY_REFRESH_MS } from '../../lib/live.ts'
import { BusyIcon } from '../../components/BusyIcon.tsx'
import { errorMessage } from '../../lib/errors.ts'

export const Route = createFileRoute('/dashboard/c/$sessionId')({
  loader: ({ params }) => getTranscript({ data: { sessionId: params.sessionId } }),
  errorComponent: ({ error }) => <LoadError title="Couldn’t load this conversation" error={error} />,
  component: Transcript,
})

function Transcript() {
  const t = Route.useLoaderData()
  const router = useRouter()
  const reply = useServerFn(agentReply)
  const setMode = useServerFn(setConversationMode)
  const archive = useServerFn(archiveConversation)
  const restore = useServerFn(restoreConversation)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmArchive, setConfirmArchive] = useState(false)
  const cancelArchive = useCallback(() => setConfirmArchive(false), [])
  const end = useRef<HTMLDivElement>(null)
  const known = useMemo(() => new Map(t.articles.map((a) => [a.slug, a])), [t.articles])

  // Live over ModelRiver's session channel: the visitor's messages and AI
  // answers arrive as messages, and a colleague's takeover or archive (or the
  // visitor leaving) as a signal; either way the transcript reloads. Without a
  // live connection it polls instead.
  const [live, setLive] = useState(false)
  const getLive = useServerFn(liveTranscript)
  const sessionId = t.sessionId
  useEffect(() => {
    let cancelled = false
    let close = () => {}
    const reload = () => void router.invalidate()
    void import('@modelriver/client').then(({ subscribeToSession }) => {
      if (cancelled) return
      const sub = subscribeToSession({
        getSubscription: () => getLive({ data: { sessionId } }),
        onMessage: reload,
        onSignal: (signal) => signal.name === CONVERSATION_UPDATED && reload(),
        onDeleted: reload,
        onLive: reload,
        onStatus: (status) => setLive(status === 'live'),
      })
      close = sub.close
    })
    return () => {
      cancelled = true
      close()
      setLive(false)
    }
  }, [sessionId, getLive, router])

  useEffect(() => {
    const timer = setInterval(() => void router.invalidate(), live ? LIVE_SAFETY_REFRESH_MS : 5000)
    return () => clearInterval(timer)
  }, [router, live])

  // Block body on purpose: newer browsers return a Promise from scrollIntoView,
  // and React would try to call a returned value as the effect's cleanup.
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [t.messages.length])

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      await router.invalidate()
    } catch (err) {
      setError(errorMessage(err, 'Something went wrong.'))
    } finally {
      setBusy(false)
    }
  }

  const sendReply = () => {
    const body = text.trim()
    if (!body || busy) return
    void run(async () => {
      await reply({ data: { sessionId: t.sessionId, text: body } })
      setText('')
    })
  }

  const fromApi = t.conversationId === null
  const ended = t.endedAt !== null
  // API sessions and conversations the visitor ended can be read, not replied to.
  const readOnly = fromApi || ended
  const human = t.mode === 'human'
  const waiting = !!t.waitingSince && !ended
  const archived = t.archivedAt !== null
  // Who has this chat. Someone else having it means you take over before replying.
  const handler = !ended ? t.handledBy : null
  const otherHandler = handler && handler.id !== t.currentUserId ? handler : null
  const aiFailed = t.handoffReason === 'ai_error'
  const takeOver = () => run(() => setMode({ data: { sessionId: t.sessionId, mode: 'human' } }))

  return (
    <div className="flex min-h-[calc(100dvh-4rem)] flex-col">
      <Link to="/dashboard" className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeftIcon size={14} />
        Conversations
      </Link>

      <div className="mt-4 mb-6 flex flex-wrap items-start justify-between gap-4 border-b border-border pb-5">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight">{t.visitorName ?? 'Conversation'}</h1>
            {archived ? (
              <Badge variant="muted">Archived</Badge>
            ) : ended ? (
              <Badge variant="muted">Ended</Badge>
            ) : waiting ? (
              <Badge variant="priority">{aiFailed ? 'AI couldn’t answer' : 'Wants a person'}</Badge>
            ) : human ? (
              !handler && <Badge variant="success">Team replying</Badge>
            ) : (
              !fromApi && <Badge variant="muted">AI answering</Badge>
            )}
            {handler && <HandlerBadge handler={handler} isMe={!otherHandler} />}
            {fromApi && <Badge variant="outline">API</Badge>}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Started <RelativeTime iso={t.insertedAt} />.{' '}
            <span className="font-mono text-xs" title="ModelRiver session ID">
              {t.sessionId}
            </span>
            {live && (
              <Tooltip content="New messages appear as they’re sent">
                <span tabIndex={0} className="ml-2 inline-flex items-center gap-1.5 text-xs font-medium text-success">
                  <span aria-hidden="true" className="size-1.5 rounded-full bg-success" />
                  Live
                </span>
              </Tooltip>
            )}
          </p>
          {(t.verifiedAs || t.lookups.length > 0) && (
            <div className="mt-2 space-y-0.5 text-xs text-muted-foreground">
              {t.verifiedAs && (
                <p className="flex items-center gap-1.5">
                  <ShieldIcon size={13} />
                  Verified as <span className="font-mono">{t.verifiedAs.email}</span>
                  {t.verifiedAs.via === 'identity_token' ? ' (signed in on your site)' : ' (email code)'}
                </p>
              )}
              {t.lookups.map((l, i) => (
                <p key={i}>
                  AI checked {l.service} for <span className="font-mono">{l.subject}</span>:{' '}
                  {l.status === 'error' ? 'couldn’t reach it' : l.status === 'rate_limited' ? 'paused by rate limits' : l.detail}
                  {' · '}
                  <RelativeTime iso={l.createdAt} />
                </p>
              ))}
            </div>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {!readOnly &&
            (otherHandler ? (
              <Button variant="outline" disabled={busy} onClick={takeOver}>
                Take over from {otherHandler.name}
              </Button>
            ) : human ? (
              <>
                {/* With the team but nobody's yet (a visitor waiting): claim it before replying. */}
                {!handler && (
                  <Button variant="outline" disabled={busy} onClick={takeOver}>
                    Take over
                  </Button>
                )}
                <Button variant="outline" disabled={busy} onClick={() => run(() => setMode({ data: { sessionId: t.sessionId, mode: 'ai' } }))}>
                  Hand back to AI
                </Button>
              </>
            ) : (
              <Button variant="outline" disabled={busy} onClick={takeOver}>
                Take over
              </Button>
            ))}
          {!archived && (
            <ConfirmPopover
              open={confirmArchive}
              title="Close this conversation?"
              message={`It ends for ${t.visitorName ?? 'the visitor'} now, and they’ll see that our team closed it.`}
              confirmLabel="Close and archive"
              busy={busy}
              onConfirm={() => void run(() => archive({ data: { sessionId: t.sessionId } })).then(cancelArchive)}
              onCancel={cancelArchive}
            >
              <Button
                variant="outline"
                disabled={busy}
                aria-expanded={!fromApi && !ended ? confirmArchive : undefined}
                onClick={() => {
                  // Still open for the visitor: confirm first. Otherwise archive straight away.
                  if (!fromApi && !ended) setConfirmArchive((o) => !o)
                  else void run(() => archive({ data: { sessionId: t.sessionId } }))
                }}
              >
                <ArchiveIcon size={15} />
                Archive
              </Button>
            </ConfirmPopover>
          )}
        </div>
      </div>

      {archived && (
        <div role="status" className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-border bg-card px-4 py-3 text-sm">
          <ArchiveIcon size={16} className="shrink-0 text-muted-foreground" />
          <p className="min-w-0 flex-1">
            Archived <RelativeTime iso={t.archivedAt!} />.{' '}
            <span className="text-muted-foreground">
              {t.deleteAt ? (
                <>
                  It’s deleted for good, here and in ModelRiver, <RelativeTime iso={t.deleteAt} future />.
                </>
              ) : (
                'It’s kept until someone restores it.'
              )}
            </span>
          </p>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void run(() => restore({ data: { sessionId: t.sessionId } }))}>
            Restore
          </Button>
        </div>
      )}

      {waiting && (
        <div role="status" className="mb-4 flex items-center gap-3 rounded-xl border border-primary/30 bg-primary/5 px-4 py-3">
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-primary/15 text-primary" aria-hidden="true">
            <HeadsetIcon size={16} />
          </span>
          <p className="text-sm">
            <span className="font-medium">
              {aiFailed ? (
                <>
                  The AI couldn’t answer {t.visitorName ?? 'the visitor'} <RelativeTime iso={t.waitingSince!} />, so the chat was
                  passed to the team.
                </>
              ) : (
                <>
                  {t.visitorName ?? 'The visitor'} asked to talk to a person <RelativeTime iso={t.waitingSince!} />.
                </>
              )}
            </span>{' '}
            <span className="text-muted-foreground">
              {otherHandler
                ? `${otherHandler.name} has taken it over.`
                : 'The AI has stopped answering. Reply below to let them know you’re here.'}
            </span>
          </p>
        </div>
      )}

      {t.truncated && <p className="mb-4 text-sm text-muted-foreground">Older messages aren’t shown.</p>}

      {t.messages.length === 0 && <p className="text-sm text-muted-foreground">No messages yet.</p>}
      <ol className={cn('divide-y divide-border overflow-hidden rounded-xl border border-border bg-card', t.messages.length === 0 && 'hidden')}>
        {t.messages.map((m) => {
          const who =
            m.author === 'agent' ? m.author_name || 'Team member' : m.author === 'ai' ? 'AI' : t.visitorName ?? 'Visitor'
          return (
            <li key={m.id} className={cn('flex gap-3 px-5 py-4', m.author === 'user' && 'bg-muted/40')}>
              {m.author === 'ai' ? (
                <HelpBot size={28} animated={false} />
              ) : (
                <span
                  className={cn(
                    'grid size-7 shrink-0 place-items-center rounded-full',
                    m.author === 'agent' ? 'bg-success/15 text-success' : 'bg-card text-muted-foreground ring-1 ring-border',
                  )}
                  aria-hidden="true"
                >
                  <UserIcon size={14} />
                </span>
              )}
              <div className="min-w-0 flex-1">
                <p className="flex items-baseline gap-2 text-sm">
                  <span className="font-medium">{who}</span>
                  <RelativeTime iso={m.created_at} className="text-xs text-muted-foreground" />
                </p>
                {m.role === 'user' ? (
                  <p className="mt-1 text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">{m.content}</p>
                ) : (
                  <Markdown
                    source={m.author === 'ai' ? linkCitations(m.content, known) : m.content}
                    className="prose-chat mt-1"
                    chat
                  />
                )}
              </div>
            </li>
          )
        })}
      </ol>
      <div ref={end} className="flex-1" />

      <div className="sticky bottom-0 mt-8 bg-background pt-2 pb-4">
        {readOnly ? (
          <p className="flex items-center gap-2 rounded-xl border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
            <LockIcon size={14} />
            {ended && t.endedAt ? (
              <span>
                The visitor ended this conversation <RelativeTime iso={t.endedAt} />, so it can’t be replied to.
              </span>
            ) : (
              'This session wasn’t started from the help-center chat, so you can read it but not reply.'
            )}
          </p>
        ) : otherHandler ? (
          // One person per conversation, so two people never answer at once.
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 text-sm">
            <p className="min-w-0 flex-1 text-muted-foreground">
              <span className="font-medium text-foreground">{otherHandler.name} is handling this conversation.</span> Take it over
              if you need to step in; replies then come from you.
            </p>
            <Button variant="outline" size="sm" disabled={busy} onClick={takeOver}>
              Take over from {otherHandler.name}
            </Button>
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              sendReply()
            }}
            className="rounded-xl border border-input bg-card p-2 shadow-sm focus-within:border-ring"
          >
            <label htmlFor="reply" className="sr-only">
              Reply as a team member
            </label>
            <textarea
              id="reply"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  sendReply()
                }
              }}
              rows={3}
              placeholder="Write a reply to the visitor…"
              className="block w-full resize-none bg-transparent px-2 pt-1 text-sm outline-none placeholder:text-muted-foreground"
            />
            <div className="flex flex-wrap items-center justify-between gap-2 pt-2 pl-2">
              <span className="text-xs text-muted-foreground">
                {waiting
                  ? 'Your reply appears in their chat straight away.'
                  : human
                    ? 'The AI is paused while you handle this chat.'
                    : 'Sending a reply pauses the AI for this chat.'}
              </span>
              <Button type="submit" size="sm" disabled={busy || !text.trim()}>
                <BusyIcon busy={busy} size={14} idle={<ArrowUpIcon size={14} />} />
                Send reply
              </Button>
            </div>
          </form>
        )}
        {error && (
          <div className="mt-2">
            <Notice tone="error">{error}</Notice>
          </div>
        )}
      </div>
    </div>
  )
}
