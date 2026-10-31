import { useState } from 'react'
import { createFileRoute, Link, useNavigate, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { getPortal, raisePortalTicket } from '../functions/customer-portal.ts'
import { PortalShell, PortalSignIn } from '../components/CustomerPortal.tsx'
import { Button, Input, Label, Notice, Select, Textarea } from '../components/ui.tsx'
import { BusyIcon } from '../components/BusyIcon.tsx'
import { errorMessage } from '../lib/errors.ts'
import { TICKET_LIMITS } from '../lib/ticket-core.ts'

// Raising a ticket from the customer portal, as the signed-in address.

// The "Something else" choice: the customer writes their own subject.
const OTHER = '__other__'
export const Route = createFileRoute('/customer-portal/new')({
  loader: () => getPortal(),
  head: () => ({ meta: [{ title: 'Raise a ticket' }, { name: 'robots', content: 'noindex, nofollow' }] }),
  headers: () => ({ 'X-Robots-Tag': 'noindex, nofollow' }),
  component: NewPortalTicket,
})

function NewPortalTicket() {
  const data = Route.useLoaderData()
  const router = useRouter()
  const navigate = useNavigate()
  const raise = useServerFn(raisePortalTicket)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // One of the subjects from Tickets → Subjects, or OTHER for their own words.
  const [choice, setChoice] = useState('')

  if (data.state !== 'home') {
    return (
      <PortalShell>
        <PortalSignIn
          title="Raise a ticket"
          intro="Sign in with your email first, so our replies reach you. We’ll send you a code."
          canEmail={data.canEmail}
          onSignedIn={() => void router.invalidate()}
        />
      </PortalShell>
    )
  }

  // New tickets are off in Settings: existing ones can still be read and answered.
  if (!data.canRaise) {
    return (
      <PortalShell signedInAs={data.signedInAs} onSignedOut={() => void router.invalidate()}>
        <Link to="/customer-portal" className="text-sm text-muted-foreground hover:text-foreground">
          ← Your tickets
        </Link>
        <h1 className="mt-4 font-serif text-3xl leading-tight">Raise a ticket</h1>
        <p className="mt-4 rounded-xl border border-border bg-card px-5 py-4 text-sm text-muted-foreground">
          We’re not taking new tickets right now. You can still reply to the ones you’ve raised, or browse{' '}
          <Link to="/articles" className="text-foreground underline underline-offset-2">
            our articles
          </Link>
          .
        </p>
      </PortalShell>
    )
  }

  return (
    <PortalShell signedInAs={data.signedInAs} onSignedOut={() => void router.invalidate()}>
      <Link to="/customer-portal" className="text-sm text-muted-foreground hover:text-foreground">
        ← Your tickets
      </Link>
      <h1 className="mt-4 font-serif text-3xl leading-tight">Raise a ticket</h1>
      <p className="mt-1.5 text-sm text-muted-foreground">Tell us what you need. Our team replies by email to {data.signedInAs}.</p>
      <form
        className="mt-6 grid gap-4 rounded-xl border border-border bg-card p-5"
        onSubmit={async (e) => {
          e.preventDefault()
          const f = new FormData(e.currentTarget)
          setBusy(true)
          setError(null)
          try {
            const subject = choice && choice !== OTHER ? choice : String(f.get('subject') ?? '')
            const res = await raise({ data: { name: String(f.get('name') ?? ''), subject, text: String(f.get('text')) } })
            void navigate({ to: '/customer-portal/tickets/$ticketRef', params: { ticketRef: res.ref } })
          } catch (err) {
            setError(errorMessage(err, 'Couldn’t raise the ticket. Please try again.'))
            setBusy(false)
          }
        }}
      >
        <Label>
          Your name
          <Input name="name" maxLength={60} autoComplete="name" placeholder="So we know what to call you" />
        </Label>
        {data.subjects.length > 0 && (
          <Label>
            What’s it about?
            <Select value={choice} onChange={(e) => setChoice(e.target.value)} required className="h-9">
              <option value="" disabled>
                Choose a subject
              </option>
              {data.subjects.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
              <option value={OTHER}>Something else</option>
            </Select>
          </Label>
        )}
        {(data.subjects.length === 0 || choice === OTHER) && (
          <Label>
            Subject
            <Input name="subject" required maxLength={TICKET_LIMITS.subject} placeholder="For example: charged twice this month" />
          </Label>
        )}
        <Label>
          What do you need help with?
          <Textarea name="text" required maxLength={TICKET_LIMITS.message} className="min-h-32 resize-y" />
        </Label>
        {error && <Notice tone="error">{error}</Notice>}
        <Button type="submit" disabled={busy} className="justify-self-end">
          <BusyIcon busy={busy} size={14} />
          Raise ticket
        </Button>
      </form>
    </PortalShell>
  )
}
