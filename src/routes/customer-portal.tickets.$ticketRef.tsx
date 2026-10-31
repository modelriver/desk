import { useEffect, useState } from 'react'
import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { openCustomerTicket } from '../functions/customer-portal.ts'
import { CustomerTicketView, PortalShell, PortalSignIn } from '../components/CustomerPortal.tsx'
import { Notice } from '../components/ui.tsx'
import { errorMessage } from '../lib/errors.ts'

// One ticket in the customer portal. The link in a reply email carries a
// private key (?k=) that signs the customer in, then leaves the address bar;
// otherwise they sign in with an email code. Only the ticket's own address can open it.
export const Route = createFileRoute('/customer-portal/tickets/$ticketRef')({
  validateSearch: (search: Record<string, unknown>): { k?: string } =>
    typeof search.k === 'string' && search.k.length <= 100 ? { k: search.k } : {},
  loaderDeps: ({ search }) => ({ key: search.k ?? null }),
  loader: ({ params, deps }) => openCustomerTicket({ data: { ref: params.ticketRef, key: deps.key } }),
  head: () => ({ meta: [{ title: 'Your ticket' }, { name: 'robots', content: 'noindex, nofollow' }] }),
  headers: () => ({ 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' }),
  errorComponent: ({ error }) => (
    <PortalShell>
      <Notice tone="error">{errorMessage(error, 'Couldn’t open this ticket.')}</Notice>
    </PortalShell>
  ),
  component: PortalTicketPage,
})

type Loaded = Awaited<ReturnType<typeof openCustomerTicket>>

function PortalTicketPage() {
  const loaded = Route.useLoaderData()
  const { k } = Route.useSearch()
  const router = useRouter()
  const [data, setData] = useState<Loaded>(loaded)
  useEffect(() => setData(loaded), [loaded])

  // The key has done its job: out of the address bar, the history and any
  // link they copy from here. Their session keeps them signed in.
  useEffect(() => {
    if (!k) return
    const url = new URL(window.location.href)
    url.searchParams.delete('k')
    window.history.replaceState(window.history.state, '', url)
  }, [k])

  if (data.state === 'ticket') {
    return (
      <PortalShell signedInAs={data.signedInAs} onSignedOut={() => void router.invalidate()}>
        <CustomerTicketView data={data} onChange={setData} />
      </PortalShell>
    )
  }
  if (data.state === 'not-yours') {
    return (
      <PortalShell signedInAs={data.signedInAs} onSignedOut={() => void router.invalidate()}>
        <h1 className="font-serif text-2xl">This ticket isn’t on your account</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          You’re signed in as {data.signedInAs}. If ticket #{data.ref} was raised with another email, sign out and sign in with that one.
        </p>
        <Link to="/customer-portal" className="mt-5 inline-block text-sm text-primary underline-offset-4 hover:underline">
          See your tickets
        </Link>
      </PortalShell>
    )
  }
  return (
    <PortalShell>
      <PortalSignIn
        title={`Ticket #${data.ref}`}
        intro={
          data.linkExpired
            ? 'That link has expired or was replaced by a newer one. Sign in with the email you raised this ticket with.'
            : 'Sign in with the email you raised this ticket with. We’ll send you a code.'
        }
        canEmail={data.canEmail}
        onSignedIn={() => void router.invalidate()}
      />
    </PortalShell>
  )
}
