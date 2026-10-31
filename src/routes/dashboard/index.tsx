import { useCallback, useEffect, useState } from 'react'
import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { archiveConversation, listConversations, restoreConversation } from '../../functions/dashboard.ts'
import { LoadError } from '../../components/LoadError.tsx'
import { HeadsetIcon, InboxIcon, XIcon } from '../../components/icons.tsx'
import { Button, EmptyState, Notice, PageHeader } from '../../components/ui.tsx'
import { ConversationList, retentionLabel, type ConversationSummary } from '../../components/ConversationList.tsx'
import { ConfirmPopover } from '../../components/ConfirmPopover.tsx'
import { Pagination } from '../../components/Pagination.tsx'
import { pageNumber } from '../../lib/paging.ts'
import { errorMessage } from '../../lib/errors.ts'
import { BusyIcon } from '../../components/BusyIcon.tsx'

type Search = { page?: number }

export const Route = createFileRoute('/dashboard/')({
  head: () => ({ meta: [{ title: 'Conversations · Dashboard' }] }),
  // ?page=2 for the next 25.
  validateSearch: (search: Record<string, unknown>): Search & { tab?: string } => {
    const page = pageNumber(search.page)
    return { ...(page > 1 ? { page } : {}), ...(search.tab === 'messages' ? { tab: 'messages' } : {}) }
  },
  // Messages left for the team used to be a tab here; they're tickets now.
  beforeLoad: ({ search }) => {
    if (search.tab === 'messages') throw redirect({ to: '/dashboard/tickets', replace: true })
  },
  loaderDeps: ({ search }) => ({ page: search.page ?? 1 }),
  loader: ({ deps }) => listConversations({ data: { view: 'open', page: deps.page } }),
  errorComponent: ({ error }) => (
    <>
      <PageHeader title="Conversations" />
      <LoadError title="Couldn’t load conversations from ModelRiver" error={error} />
    </>
  ),
  component: Conversations,
})

function Conversations() {
  const data = Route.useLoaderData()
  const router = useRouter()

  // Refresh the list every 10 seconds while it is open.
  useEffect(() => {
    const timer = setInterval(() => void router.invalidate(), 10_000)
    return () => clearInterval(timer)
  }, [router])

  return (
    <>
      <PageHeader
        title="Conversations"
        description="Every chat from the help center, newest first, with anyone waiting for a person at the top. History is read from ModelRiver sessions and updates on its own."
      />
      <ConversationsList
        conversations={data.conversations}
        waiting={data.waitingCount}
        retentionHours={data.retentionHours}
        currentUserId={data.currentUserId}
      />
      <Pagination {...data} noun="conversations" link={(n) => ({ to: '/dashboard', search: n > 1 ? { page: n } : {} })} />
      {data.capped && data.page === data.pages && (
        <p className="mt-3 text-xs text-muted-foreground">Only the newest {data.total} conversations are listed. Older ones are still in ModelRiver.</p>
      )}
    </>
  )
}

type ListData = Awaited<ReturnType<typeof listConversations>>

function ConversationsList({
  conversations,
  waiting,
  retentionHours,
  currentUserId,
}: Pick<ListData, 'conversations' | 'retentionHours' | 'currentUserId'> & { waiting: number }) {
  const router = useRouter()
  const archive = useServerFn(archiveConversation)
  const restore = useServerFn(restoreConversation)
  const [error, setError] = useState<string | null>(null)
  // Archived from here: off the list at once, before the server answers, and
  // back if it refuses. The list reloads behind the scenes.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set())
  const hide = (id: string, on: boolean) =>
    setHidden((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  // The last one archived from here, so it can be undone.
  const [archived, setArchived] = useState<{ sessionId: string; name: string } | null>(null)
  const [undoing, setUndoing] = useState(false)
  // The row whose "close and archive" confirmation is showing.
  const [confirming, setConfirming] = useState<string | null>(null)
  const cancelConfirm = useCallback(() => setConfirming(null), [])
  const shown = conversations.filter((c) => !hidden.has(c.sessionId))

  const doArchive = async (c: ConversationSummary) => {
    setConfirming(null)
    setError(null)
    hide(c.sessionId, true)
    setArchived({ sessionId: c.sessionId, name: c.visitorName ?? 'this visitor' })
    try {
      await archive({ data: { sessionId: c.sessionId } })
      void router.invalidate()
    } catch (err) {
      hide(c.sessionId, false)
      setArchived((a) => (a?.sessionId === c.sessionId ? null : a))
      setError(errorMessage(err, 'Couldn’t archive it. Try again.'))
    }
  }

  const undo = async (a: { sessionId: string; name: string }) => {
    setUndoing(true)
    setError(null)
    try {
      await restore({ data: { sessionId: a.sessionId } })
      await router.invalidate()
      hide(a.sessionId, false)
      setArchived(null)
    } catch (err) {
      setError(errorMessage(err, 'Couldn’t restore it. Try again.'))
    } finally {
      setUndoing(false)
    }
  }

  // The Undo notice goes away on its own after a while.
  useEffect(() => {
    if (!archived || undoing) return
    const timer = setTimeout(() => setArchived(null), 10_000)
    return () => clearTimeout(timer)
  }, [archived, undoing])

  // A conversation the visitor still has open ends for them, so that asks
  // first; anything already ended is archived straight away (with Undo).
  const isOpen = (c: ConversationSummary) => c.conversationId !== null && !c.endedAt

  return (
    <>
      {waiting > 0 && (
        <div role="status" className="mb-4 flex items-center gap-3 rounded-xl border border-primary/30 bg-primary/5 px-4 py-3">
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-primary/15 text-primary" aria-hidden="true">
            <HeadsetIcon size={16} />
          </span>
          <p className="text-sm">
            <span className="font-medium">
              {waiting === 1 ? '1 person is' : `${waiting} people are`} waiting to talk to the team.
            </span>{' '}
            <span className="text-muted-foreground">They’re at the top of the list, longest wait first.</span>
          </p>
        </div>
      )}
      {/* Floats over the page instead of pushing the list down. */}
      {archived && (
        <div className="pointer-events-none fixed inset-x-0 bottom-5 z-40 flex justify-center px-4">
          <div
            role="status"
            className="pointer-events-auto flex max-w-lg flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-border bg-card py-2 pr-2 pl-4 text-sm"
          >
            <span className="min-w-0 flex-1">
              Archived the conversation with {archived.name}.{' '}
              <span className="text-muted-foreground">
                {retentionHours > 0 ? `It’s deleted for good in ${retentionLabel(retentionHours)}.` : 'It’s kept in Archived.'}
              </span>
            </span>
            <Button variant="ghost" size="sm" disabled={undoing} onClick={() => void undo(archived)}>
              <BusyIcon busy={undoing} size={14} />
              Undo
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={() => setArchived(null)} aria-label="Dismiss">
              <XIcon size={15} />
            </Button>
          </div>
        </div>
      )}
      {error && (
        <div className="mb-4">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
      {shown.length === 0 ? (
        <EmptyState icon={<InboxIcon />} title="No conversations yet">
          They appear here as soon as someone asks a question in the chat on the help center.
        </EmptyState>
      ) : (
        <ConversationList
          conversations={shown}
          currentUserId={currentUserId}
          action={(c) => (
            <ConfirmPopover
              open={confirming === c.sessionId}
              title="Close this conversation?"
              message={`It ends for ${c.visitorName ?? 'the visitor'} now, and they’ll see that our team closed it.`}
              confirmLabel="Close and archive"
              onConfirm={() => void doArchive(c)}
              onCancel={cancelConfirm}
            >
              <Button
                variant="ghost-destructive"
                size="icon-sm"
                onClick={() => (isOpen(c) ? setConfirming((s) => (s === c.sessionId ? null : c.sessionId)) : void doArchive(c))}
                aria-label={`Archive the conversation with ${c.visitorName ?? 'this visitor'}`}
                aria-expanded={isOpen(c) ? confirming === c.sessionId : undefined}
                title="Close and archive"
              >
                <XIcon />
              </Button>
            </ConfirmPopover>
          )}
        />
      )}
    </>
  )
}
