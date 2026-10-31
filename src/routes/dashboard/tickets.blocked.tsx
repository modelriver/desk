import { useState } from 'react'
import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { blockCustomerEmail, listBlockedCustomers, unblockCustomerEmail } from '../../functions/tickets.ts'
import { LoadError } from '../../components/LoadError.tsx'
import { ArrowLeftIcon, ShieldIcon } from '../../components/icons.tsx'
import { Button, EmptyState, Input, Notice, PageHeader } from '../../components/ui.tsx'
import { RelativeTime } from '../../components/RelativeTime.tsx'
import { BusyIcon } from '../../components/BusyIcon.tsx'
import { errorMessage } from '../../lib/errors.ts'

// Addresses blocked from the customer portal and from raising tickets, with
// who blocked them and why; unblock, or block one before it causes trouble.
export const Route = createFileRoute('/dashboard/tickets/blocked')({
  head: () => ({ meta: [{ title: 'Blocked customers · Dashboard' }] }),
  loader: () => listBlockedCustomers(),
  errorComponent: ({ error }) => <LoadError title="Couldn’t load blocked customers" error={error} />,
  component: BlockedCustomers,
})

function BlockedCustomers() {
  const { blocked } = Route.useLoaderData()
  const router = useRouter()
  const block = useServerFn(blockCustomerEmail)
  const unblock = useServerFn(unblockCustomerEmail)
  const [email, setEmail] = useState('')
  const [reason, setReason] = useState('')
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
        title="Blocked customers"
        description="These addresses can’t sign in to the customer portal, open links from our emails, raise tickets or reply. They aren’t told, and you can still email them."
      />
      <form
        className="mb-6 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card p-4"
        onSubmit={(e) => {
          e.preventDefault()
          void run('add', () => block({ data: { email, reason } })).then((ok) => {
            if (ok) {
              setEmail('')
              setReason('')
            }
          })
        }}
      >
        <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="someone@example.com" aria-label="Email to block" className="sm:w-64" />
        <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why (optional, only your team sees it)" aria-label="Reason" maxLength={200} className="min-w-0 flex-1" />
        <Button type="submit" variant="outline" disabled={busy !== null || !email.trim()}>
          <BusyIcon busy={busy === 'add'} size={14} />
          Block
        </Button>
      </form>
      {error && (
        <div className="mb-4">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
      {blocked.length === 0 ? (
        <EmptyState icon={<ShieldIcon />} title="Nobody is blocked">
          Block a customer from their ticket, or add an address above.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border bg-card">
          {blocked.map((b) => (
            <li key={b.email} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{b.email}</span>
                <span className="block text-xs text-muted-foreground">
                  Blocked by {b.blockedBy ?? 'someone'} <RelativeTime iso={b.blockedAt} />
                  {b.reason ? ` · ${b.reason}` : ''}
                </span>
              </span>
              <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void run(b.email, () => unblock({ data: { email: b.email } }))}>
                <BusyIcon busy={busy === b.email} size={14} />
                Unblock
              </Button>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
