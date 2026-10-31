import { useState } from 'react'
import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { addTicketSubjectName, listTicketSubjectsPage, moveTicketSubjectName, removeTicketSubjectName } from '../../functions/tickets.ts'
import { LoadError } from '../../components/LoadError.tsx'
import { ArrowDownIcon, ArrowLeftIcon, ArrowUpIcon, TicketIcon, TrashIcon } from '../../components/icons.tsx'
import { Button, EmptyState, Input, Notice, PageHeader } from '../../components/ui.tsx'
import { BusyIcon } from '../../components/BusyIcon.tsx'
import { errorMessage } from '../../lib/errors.ts'

// The subjects customers pick from when they raise a ticket, in the chat and
// the customer portal, in the order shown here. Admins change them.
export const Route = createFileRoute('/dashboard/tickets/subjects')({
  head: () => ({ meta: [{ title: 'Ticket subjects · Dashboard' }] }),
  loader: () => listTicketSubjectsPage(),
  errorComponent: ({ error }) => <LoadError title="Couldn’t load ticket subjects" error={error} />,
  component: TicketSubjects,
})

const NAME_MAX = 60

function TicketSubjects() {
  const { subjects, canEdit } = Route.useLoaderData()
  const router = useRouter()
  const add = useServerFn(addTicketSubjectName)
  const remove = useServerFn(removeTicketSubjectName)
  const move = useServerFn(moveTicketSubjectName)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key)
    setError(null)
    try {
      await fn()
      await router.invalidate()
      return true
    } catch (err) {
      setError(errorMessage(err, 'Something went wrong. Try again.'))
      return false
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <Link to="/dashboard/tickets" className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeftIcon size={14} />
        Tickets
      </Link>
      <PageHeader
        title="Ticket subjects"
        description="What customers pick from when they raise a ticket, in the chat and the customer portal, in this order. They can also choose “Something else”. With none, the portal asks for a subject and the chat takes one from the message."
      />
      {canEdit ? (
        <form
          className="mb-6 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card p-4"
          onSubmit={(e) => {
            e.preventDefault()
            void run('add', () => add({ data: { name } })).then((ok) => ok && setName(''))
          }}
        >
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="For example: Billing and payments"
            aria-label="New subject"
            maxLength={NAME_MAX}
            className="min-w-0 flex-1"
          />
          <Button type="submit" variant="outline" disabled={busy !== null || !name.trim()}>
            <BusyIcon busy={busy === 'add'} size={14} />
            Add subject
          </Button>
        </form>
      ) : (
        <p className="mb-6 text-sm text-muted-foreground">Only admins can change these.</p>
      )}
      {error && (
        <div className="mb-4">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
      {subjects.length === 0 ? (
        <EmptyState icon={<TicketIcon />} title="No subjects yet">
          {canEdit ? 'Add the few things people usually write about, like billing, a bug or an order.' : 'An admin can add the subjects customers pick from.'}
        </EmptyState>
      ) : (
        <ol className="divide-y divide-border rounded-xl border border-border bg-card">
          {subjects.map((s, i) => (
            <li key={s.id} className="flex items-center gap-3 px-4 py-2.5">
              <span className="w-5 shrink-0 text-right text-xs text-muted-foreground tabular-nums">{i + 1}</span>
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{s.name}</span>
              {canEdit && (
                <span className="flex shrink-0 items-center gap-0.5">
                  <Button variant="ghost" size="icon-sm" aria-label={`Move ${s.name} up`} disabled={busy !== null || i === 0} onClick={() => void run(`up-${s.id}`, () => move({ data: { id: s.id, by: -1 } }))}>
                    <ArrowUpIcon size={14} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Move ${s.name} down`}
                    disabled={busy !== null || i === subjects.length - 1}
                    onClick={() => void run(`down-${s.id}`, () => move({ data: { id: s.id, by: 1 } }))}
                  >
                    <ArrowDownIcon size={14} />
                  </Button>
                  <Button variant="ghost" size="icon-sm" aria-label={`Remove ${s.name}`} disabled={busy !== null} onClick={() => void run(`rm-${s.id}`, () => remove({ data: { id: s.id } }))}>
                    {busy === `rm-${s.id}` ? <BusyIcon busy size={14} /> : <TrashIcon size={14} />}
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
    </>
  )
}
