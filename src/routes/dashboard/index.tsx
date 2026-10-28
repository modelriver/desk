import { useCallback, useEffect, useState } from 'react'
import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { archiveConversation, listConversations, restoreConversation } from '../../functions/dashboard.ts'
import { LoadError } from '../../components/LoadError.tsx'
import { HeadsetIcon, InboxIcon, XIcon } from '../../components/icons.tsx'
import { Button, EmptyState, Notice, PageHeader } from '../../components/ui.tsx'
import { ConversationList, retentionLabel, type ConversationSummary } from '../../components/ConversationList.tsx'
import { ConfirmPopover } from '../../components/ConfirmPopover.tsx'
import { errorMessage } from '../../lib/errors.ts'

export const Route = createFileRoute('/dashboard/')({
  loader: () => listConversations({ data: { view: 'open' } }),
  errorComponent: ({ error }) => (
    <>
      <PageHeader title="Conversations" />
      <LoadError title="Couldn’t load conversations from ModelRiver" error={error} />
    </>
  ),
  component: Conversations,
})

function Conversations() {
  const { conversations, retentionHours, currentUserId } = Route.useLoaderData()
  const router = useRouter()
  const archive = useServerFn(archiveConversation)
  const restore = useServerFn(restoreConversation)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The last one archived from here, so it can be undone.
  const [archived, setArchived] = useState<{ sessionId: string; name: string } | null>(null)
  // The row whose "close and archive" confirmation is showing.
  const [confirming, setConfirming] = useState<string | null>(null)
  const cancelConfirm = useCallback(() => setConfirming(null), [])
  const waiting = conversations.filter((c) => c.waitingSince && !c.endedAt).length

  // Refresh the list every 10 seconds while it is open.
  useEffect(() => {
    const timer = setInterval(() => void router.invalidate(), 10_000)
    return () => clearInterval(timer)
  }, [router])

  const run = async (sessionId: string, fn: () => Promise<unknown>) => {
    setBusy(sessionId)
    setError(null)
    try {
      await fn()
      await router.invalidate()
    } catch (err) {
      setError(errorMessage(err, 'Something went wrong.'))
    } finally {
      setBusy(null)
    }
  }

  const doArchive = (c: ConversationSummary) =>
    void run(c.sessionId, async () => {
      await archive({ data: { sessionId: c.sessionId } })
      setConfirming(null)
      setArchived({ sessionId: c.sessionId, name: c.visitorName ?? 'this visitor' })
    })

  // A conversation the visitor still has open ends for them, so that asks
  // first; anything already ended is archived straight away (with Undo).
  const isOpen = (c: ConversationSummary) => c.conversationId !== null && !c.endedAt

  return (
    <>
      <PageHeader
        title="Conversations"
        description="Every chat from the help center, newest first, with anyone waiting for a person at the top. History is read from ModelRiver sessions and updates on its own."
      />
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
      {archived && (
        <div role="status" className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-border bg-card px-4 py-2.5 text-sm">
          <span className="min-w-0 flex-1">
            Archived the conversation with {archived.name}.{' '}
            <span className="text-muted-foreground">
              {retentionHours > 0 ? `It’s deleted for good in ${retentionLabel(retentionHours)}.` : 'It’s kept in Archived.'}
            </span>
          </span>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy !== null}
            onClick={() =>
              void run(archived.sessionId, async () => {
                await restore({ data: { sessionId: archived.sessionId } })
                setArchived(null)
              })
            }
          >
            Undo
          </Button>
        </div>
      )}
      {error && (
        <div className="mb-4">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
      {conversations.length === 0 ? (
        <EmptyState icon={<InboxIcon />} title="No conversations yet">
          They appear here as soon as someone asks a question in the chat on the help center.
        </EmptyState>
      ) : (
        <ConversationList
          conversations={conversations}
          currentUserId={currentUserId}
          action={(c) => (
            <ConfirmPopover
              open={confirming === c.sessionId}
              title="Close this conversation?"
              message={`It ends for ${c.visitorName ?? 'the visitor'} now, and they’ll see that our team closed it.`}
              confirmLabel="Close and archive"
              busy={busy === c.sessionId}
              onConfirm={() => doArchive(c)}
              onCancel={cancelConfirm}
            >
              <Button
                variant="ghost-destructive"
                size="icon-sm"
                disabled={busy !== null}
                onClick={() => (isOpen(c) ? setConfirming((s) => (s === c.sessionId ? null : c.sessionId)) : doArchive(c))}
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
