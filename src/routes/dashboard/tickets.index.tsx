import { useEffect, useState } from 'react'
import { createFileRoute, Link, useNavigate, useRouter } from '@tanstack/react-router'
import { listTicketsPage } from '../../functions/tickets.ts'
import { LoadError } from '../../components/LoadError.tsx'
import { ChevronRightIcon, PlusIcon, ShieldIcon, TicketIcon } from '../../components/icons.tsx'
import { Badge, Button, EmptyState, PageHeader, Select } from '../../components/ui.tsx'
import { TabBar } from '../../components/TabBar.tsx'
import { ActionsMenu } from '../../components/ActionsMenu.tsx'
import { Pagination } from '../../components/Pagination.tsx'
import { RelativeTime } from '../../components/RelativeTime.tsx'
import { NewTicketDialog } from '../../components/NewTicketDialog.tsx'
import { pageNumber } from '../../lib/paging.ts'
import { initials } from '../../lib/initials.ts'

type View = 'open' | 'pending' | 'solved'
type Assignee = 'all' | 'mine' | 'unassigned'
type Search = { status?: Exclude<View, 'open'>; assignee?: Exclude<Assignee, 'all'>; page?: number }

const VIEWS: Array<{ id: View; label: string }> = [
  { id: 'open', label: 'Open' },
  { id: 'pending', label: 'Waiting on customer' },
  { id: 'solved', label: 'Solved' },
]

export const Route = createFileRoute('/dashboard/tickets/')({
  head: () => ({ meta: [{ title: 'Tickets · Dashboard' }] }),
  // ?status=pending|solved, ?assignee=mine|unassigned, ?page=2. Open and everyone are the defaults.
  validateSearch: (search: Record<string, unknown>): Search => {
    const page = pageNumber(search.page)
    return {
      ...(search.status === 'pending' || search.status === 'solved' ? { status: search.status } : {}),
      ...(search.assignee === 'mine' || search.assignee === 'unassigned' ? { assignee: search.assignee } : {}),
      ...(page > 1 ? { page } : {}),
    }
  },
  loaderDeps: ({ search }) => ({ view: search.status ?? 'open', assignee: search.assignee ?? 'all', page: search.page ?? 1 }),
  loader: ({ deps }) => listTicketsPage({ data: deps }),
  errorComponent: ({ error }) => (
    <>
      <PageHeader title="Tickets" />
      <LoadError title="Couldn’t load tickets" error={error} />
    </>
  ),
  component: Tickets,
})

// Requests the team answers by email: left from the chat while "Talk with a
// person" is off, turned from a chat, or opened by hand.
function Tickets() {
  const data = Route.useLoaderData()
  const search = Route.useSearch()
  const view: View = search.status ?? 'open'
  const assignee: Assignee = search.assignee ?? 'all'
  const router = useRouter()
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)

  // New tickets show up without a reload.
  useEffect(() => {
    const timer = setInterval(() => void router.invalidate(), 15_000)
    return () => clearInterval(timer)
  }, [router])

  const searchFor = (next: { view?: View; assignee?: Assignee; page?: number }): Search => {
    const v = next.view ?? view
    const a = next.assignee ?? assignee
    return {
      ...(v !== 'open' ? { status: v } : {}),
      ...(a !== 'all' ? { assignee: a } : {}),
      ...(next.page && next.page > 1 ? { page: next.page } : {}),
    }
  }

  return (
    <>
      <PageHeader
        title="Tickets"
        description="Requests your team answers by email: raised in the chat or the customer portal, chats turned into tickets, and ones you open yourself."
        actions={
          <>
            <ActionsMenu
              label="Manage tickets"
              button={{ content: 'Manage', variant: 'outline' }}
              items={[
                { label: 'Subjects', icon: <TicketIcon size={15} />, onSelect: () => void navigate({ to: '/dashboard/tickets/subjects' }) },
                { label: 'Blocked customers', icon: <ShieldIcon size={15} />, onSelect: () => void navigate({ to: '/dashboard/tickets/blocked' }) },
              ]}
            />
            <Button onClick={() => setCreating(true)}>
              <PlusIcon size={15} />
              New ticket
            </Button>
          </>
        }
      />
      <NewTicketDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(ref) => void navigate({ to: '/dashboard/tickets/$ticketRef', params: { ticketRef: ref } })}
      />

      <TabBar
          label="Ticket status"
          active={view}
          tabs={VIEWS.map((v) => ({
            id: v.id,
            label: (
              <>
                {v.label}
                <span className="text-xs text-muted-foreground tabular-nums">{data.counts[v.id]}</span>
              </>
            ),
            link: { to: '/dashboard/tickets', search: searchFor({ view: v.id }) },
          }))}
          aside={
            <label className="flex items-center gap-2 text-sm whitespace-nowrap text-muted-foreground">
              Assigned to
              <Select
                value={assignee}
                onChange={(e) => void navigate({ to: '/dashboard/tickets', search: searchFor({ assignee: e.target.value as Assignee }) })}
                className="w-36"
              >
                <option value="all">Anyone</option>
                <option value="mine">Me</option>
                <option value="unassigned">Nobody</option>
              </Select>
            </label>
          }
        />

      {data.tickets.length === 0 ? (
        <EmptyState icon={<TicketIcon />} title={view === 'open' ? 'No open tickets' : view === 'pending' ? 'Nothing waiting on customers' : 'No solved tickets'}>
          {view === 'open'
            ? 'When “Talk with a person” is off, visitors who ask for the team can raise a ticket, and it lands here. You can also open one yourself.'
            : view === 'pending'
              ? 'Tickets you replied to wait here for the customer. Set one back to Open when they answer.'
              : 'Solved tickets are kept for 90 days.'}
        </EmptyState>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border bg-card">
          {data.tickets.map((t) => (
            <li key={t.id}>
              <Link
                to="/dashboard/tickets/$ticketRef"
                params={{ ticketRef: t.ref }}
                className="flex items-center gap-3 px-4 py-3 first:rounded-t-xl last:rounded-b-xl hover:bg-muted/60"
              >
                <span className="w-16 shrink-0 font-mono text-xs text-muted-foreground">#{t.ref}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{t.subject}</span>
                  <span className="block truncate text-sm text-muted-foreground">
                    {t.visitorName}
                    {t.email ? ` · ${t.email}` : ''}
                    {/* The latest message, unless the subject already says it. */}
                    {t.preview && !t.preview.startsWith(t.subject.replace(/…$/, '')) ? ` · ${t.preview}` : ''}
                  </span>
                </span>
                {t.source === 'team' && <Badge variant="outline">Opened by the team</Badge>}
                {t.source === 'portal' && <Badge variant="outline">Portal</Badge>}
                {t.assignee ? (
                  <Badge variant="success" title={`${t.assignee.name} has this ticket`}>
                    <span className="-ml-1 grid size-4 place-items-center rounded-full bg-success text-[9px] font-semibold text-background" aria-hidden="true">
                      {initials(t.assignee.name)}
                    </span>
                    {t.assignee.id === data.currentUserId ? 'You' : t.assignee.name}
                  </Badge>
                ) : (
                  view !== 'solved' && <Badge variant="muted">Unassigned</Badge>
                )}
                <span className="w-24 shrink-0 text-right text-xs text-muted-foreground max-sm:hidden">
                  <RelativeTime iso={view === 'open' ? t.createdAt : t.updatedAt} />
                </span>
                <ChevronRightIcon size={16} className="shrink-0 text-muted-foreground" />
              </Link>
            </li>
          ))}
        </ul>
      )}
      <Pagination {...data} noun="tickets" link={(n) => ({ to: '/dashboard/tickets', search: searchFor({ page: n }) })} />
    </>
  )
}
