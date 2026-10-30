import { useEffect, useState } from 'react'
import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { listConversations, restoreConversation } from '../../functions/dashboard.ts'
import { LoadError } from '../../components/LoadError.tsx'
import { ArchiveIcon } from '../../components/icons.tsx'
import { Button, EmptyState, Notice, PageHeader } from '../../components/ui.tsx'
import { ConversationList, retentionLabel } from '../../components/ConversationList.tsx'
import { errorMessage } from '../../lib/errors.ts'

export const Route = createFileRoute('/dashboard/archived')({
  head: () => ({ meta: [{ title: 'Archived · Dashboard' }] }),
  loader: () => listConversations({ data: { view: 'archived' } }),
  errorComponent: ({ error }) => (
    <>
      <PageHeader title="Archived" />
      <LoadError title="Couldn’t load archived conversations" error={error} />
    </>
  ),
  component: Archived,
})

function Archived() {
  const { conversations, retentionHours, currentUserId } = Route.useLoaderData()
  const router = useRouter()
  const restore = useServerFn(restoreConversation)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Keeps "Deleted in …" honest and drops rows the cleanup removed.
  useEffect(() => {
    const timer = setInterval(() => void router.invalidate(), 60_000)
    return () => clearInterval(timer)
  }, [router])

  return (
    <>
      <PageHeader
        title="Archived"
        description={
          retentionHours > 0
            ? `Closed conversations. Each one is deleted for good, here and in ModelRiver, ${retentionLabel(retentionHours)} after it was archived. Restore one to keep it.`
            : 'Closed conversations. They’re kept until you restore them (ARCHIVE_RETENTION_HOURS is 0).'
        }
      />
      {error && (
        <div className="mb-4">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
      {conversations.length === 0 ? (
        <EmptyState icon={<ArchiveIcon />} title="Nothing archived">
          Close a conversation with the × on its row in Conversations to move it here.
        </EmptyState>
      ) : (
        <ConversationList
          conversations={conversations}
          currentUserId={currentUserId}
          action={(c) => (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                setError(null)
                try {
                  await restore({ data: { sessionId: c.sessionId } })
                  await router.invalidate()
                } catch (err) {
                  setError(errorMessage(err, 'Couldn’t restore it. Try again.'))
                } finally {
                  setBusy(false)
                }
              }}
            >
              Restore
            </Button>
          )}
        />
      )}
    </>
  )
}
