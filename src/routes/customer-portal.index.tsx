import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { getPortal } from '../functions/customer-portal.ts'
import { PORTAL_STATUS, PortalShell, PortalSignIn } from '../components/CustomerPortal.tsx'
import { buttonClass } from '../components/ui.tsx'
import { PlusIcon, TicketIcon, ChevronRightIcon } from '../components/icons.tsx'
import { RelativeTime } from '../components/RelativeTime.tsx'
import { cn } from '../lib/cn.ts'

// The customer portal's home: sign in with an email code, then every ticket
// raised with that address, and a way to raise a new one.
export const Route = createFileRoute('/customer-portal/')({
  loader: () => getPortal(),
  head: () => ({ meta: [{ title: 'Your tickets' }, { name: 'robots', content: 'noindex, nofollow' }] }),
  headers: () => ({ 'X-Robots-Tag': 'noindex, nofollow' }),
  component: PortalHome,
})

function PortalHome() {
  const data = Route.useLoaderData()
  const router = useRouter()
  if (data.state !== 'home') {
    return (
      <PortalShell>
        <PortalSignIn
          title="Your tickets"
          intro="Sign in with your email to see your tickets, read our replies and answer them. We’ll send you a code."
          canEmail={data.canEmail}
          onSignedIn={() => void router.invalidate()}
        />
      </PortalShell>
    )
  }
  return (
    <PortalShell signedInAs={data.signedInAs} onSignedOut={() => void router.invalidate()}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-serif text-3xl leading-tight">Your tickets</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">Everything you’ve raised with us, newest activity first.</p>
        </div>
        {data.canRaise && (
          <Link to="/customer-portal/new" className={buttonClass('default')}>
            <PlusIcon size={15} />
            Raise a ticket
          </Link>
        )}
      </div>
      {data.tickets.length === 0 ? (
        <div className="mt-8 flex flex-col items-center rounded-xl border border-dashed border-border px-6 py-12 text-center">
          <span className="grid size-10 place-items-center rounded-full bg-muted text-muted-foreground" aria-hidden="true">
            <TicketIcon size={18} />
          </span>
          <p className="mt-3 font-medium">No tickets yet</p>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            {data.canRaise ? 'When you raise one, here or in the chat, it shows up here with our replies.' : 'Tickets you raise with us show up here with our replies.'}
          </p>
        </div>
      ) : (
        <ul className="mt-8 divide-y divide-border rounded-xl border border-border bg-card">
          {data.tickets.map((t) => (
            <li key={t.ref}>
              <Link
                to="/customer-portal/tickets/$ticketRef"
                params={{ ticketRef: t.ref }}
                className="flex items-center gap-3 px-4 py-3.5 first:rounded-t-xl last:rounded-b-xl hover:bg-muted/60"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{t.subject}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    <span className="font-mono">#{t.ref}</span> · updated <RelativeTime iso={t.updatedAt} />
                  </span>
                </span>
                <span className={cn('shrink-0 rounded-full px-2.5 py-1 text-xs font-medium whitespace-nowrap', PORTAL_STATUS[t.status].tone)}>
                  {PORTAL_STATUS[t.status].label}
                </span>
                <ChevronRightIcon size={16} className="shrink-0 text-muted-foreground" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </PortalShell>
  )
}
