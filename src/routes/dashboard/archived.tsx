import { useEffect, useState } from 'react'
import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { listConversations, restoreConversation } from '../../functions/dashboard.ts'
import { LoadError } from '../../components/LoadError.tsx'
import { ArchiveIcon } from '../../components/icons.tsx'
import { Button, EmptyState, Notice, PageHeader } from '../../components/ui.tsx'
import { ConversationList, retentionLabel } from '../../components/ConversationList.tsx'
import { errorMessage } from '../../lib/errors.ts'
import { Pagination } from '../../components/Pagination.tsx'
import { pageNumber } from '../../lib/paging.ts'

export const Route = createFileRoute('/dashboard/archived')({
  head: () => ({ meta: [{ title: 'Archived · Dashboard' }] }),
  // ?page=2 for the next 25.
  validateSearch: (search: Record<string, unknown>): { page?: number } => (pageNumber(search.page) > 1 ? { page: pageNumber(search.page) } : {}),
  loaderDeps: ({ search }) => ({ page: search.page ?? 1 }),
  loader: ({ deps }) => listConversations({ data: { view: 'archived', page: deps.page } }),
  errorComponent: ({ error }) => (
    <>
      <PageHeader title="Archived" />
      <LoadError title="Couldn’t load archived conversations" error={error} />
    </>
  ),
  component: Archived,
})

function Archived() {
  const data = Route.useLoaderData()
  const { conversations, retentionHours, currentUserId } = data
  const router = useRouter()
  const restore = useServerFn(restoreConversation)
  const [error, setError] = useState<string | null>(null)
  // Restored from here: off this list at once, and back if the server refuses.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set())
  const shown = conversations.filter((c) => !hidden.has(c.sessionId))
  const hide = (id: string, on: boolean) =>
    setHidden((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })

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
      {shown.length === 0 ? (
        <EmptyState icon={<ArchiveIcon />} title="Nothing archived">
          Close a conversation with the × on its row in Conversations to move it here.
        </EmptyState>
      ) : (
        <ConversationList
          conversations={shown}
          currentUserId={currentUserId}
          action={(c) => (
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                setError(null)
                hide(c.sessionId, true)
                try {
                  await restore({ data: { sessionId: c.sessionId } })
                  void router.invalidate()
                } catch (err) {
                  hide(c.sessionId, false)
                  setError(errorMessage(err, 'Couldn’t restore it. Try again.'))
                }
              }}
            >
              Restore
            </Button>
          )}
        />
      )}
      <Pagination {...data} noun="conversations" link={(n) => ({ to: '/dashboard/archived', search: n > 1 ? { page: n } : {} })} />
    </>
  )
}
