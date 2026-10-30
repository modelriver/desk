import { useId, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { getMyAccount, setMyNotifications } from '../../functions/account.ts'
import { setPassword } from '../../functions/users.ts'
import { LoadError } from '../../components/LoadError.tsx'
import { Badge, Button, Input, Label, Notice, PageHeader, Section, Switch } from '../../components/ui.tsx'
import { RelativeTime } from '../../components/RelativeTime.tsx'
import { errorMessage } from '../../lib/errors.ts'

// Every team member's own settings: who they are, which emails they get and
// their password. The app's settings are separate and admin-only.
export const Route = createFileRoute('/dashboard/account')({
  head: () => ({ meta: [{ title: 'Account · Dashboard' }] }),
  loader: () => getMyAccount(),
  errorComponent: ({ error }) => (
    <>
      <PageHeader title="Account settings" />
      <LoadError title="Couldn’t load your account" error={error} />
    </>
  ),
  component: AccountPage,
})

type Account = Awaited<ReturnType<typeof getMyAccount>>

function AccountPage() {
  const loaded = Route.useLoaderData()
  const { user } = Route.useRouteContext()
  const [account, setAccount] = useState<Account>(loaded)

  return (
    <>
      <PageHeader title="Account settings" description="Your own sign-in and notifications." />
      <div className="grid gap-5">
        <Section title="Profile">
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
            <div className="min-w-0">
              <p className="flex items-center gap-2 font-medium">
                {account.name}
                <Badge variant={account.role === 'admin' ? 'default' : 'muted'} className="capitalize">
                  {account.role}
                </Badge>
              </p>
              <p className="text-sm text-muted-foreground">{account.email}</p>
            </div>
            <p className="text-sm text-muted-foreground">
              {account.twoFactorSince ? (
                <>
                  Two-factor on since <RelativeTime iso={account.twoFactorSince} />
                </>
              ) : (
                'Two-factor not set up'
              )}
            </p>
          </div>
        </Section>

        <Notifications account={account} isAdmin={user.role === 'admin'} onSaved={setAccount} />
        <PasswordForm userId={user.id} />
      </div>
    </>
  )
}

function Notifications({ account, isAdmin, onSaved }: { account: Account; isAdmin: boolean; onSaved: (a: Account) => void }) {
  const save = useServerFn(setMyNotifications)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const update = async (next: Account['notifications']) => {
    setBusy(true)
    setError(null)
    try {
      onSaved(await save({ data: next }))
    } catch (err) {
      setError(errorMessage(err, 'Couldn’t save. Try again.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section
      title="Email notifications"
      description={`Sent to ${account.email}. Updates that arrive close together come as one email, and you get at most 20 an hour.`}
    >
      {!account.emailReady && (
        <p className="border-b border-border bg-muted/50 px-5 py-3 text-sm text-muted-foreground">
          Email isn’t set up on this server yet, so nothing is sent.{' '}
          {isAdmin ? 'See Email under Settings.' : 'Ask an admin to set it up.'} Your choices are kept for when it is.
        </p>
      )}
      <ToggleRow
        title="Someone wants a person"
        detail="When a visitor asks for the team, or the AI couldn’t answer and passed the chat on."
        checked={account.notifications.handoff}
        disabled={busy}
        onChange={(v) => void update({ ...account.notifications, handoff: v })}
      />
      <ToggleRow
        title="Every new conversation"
        detail="Once when a conversation starts, with the visitor’s first question. Not for each message."
        checked={account.notifications.newConversations}
        disabled={busy}
        onChange={(v) => void update({ ...account.notifications, newConversations: v })}
      />
      {error && (
        <div className="px-5 py-3">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
    </Section>
  )
}

function ToggleRow(props: { title: string; detail: string; checked: boolean; disabled: boolean; onChange: (v: boolean) => void }) {
  const id = useId()
  return (
    <div className="flex items-start justify-between gap-6 border-b border-border px-5 py-4 last:border-b-0">
      <div className="min-w-0">
        <p id={`${id}-title`} className="text-sm font-medium">
          {props.title}
        </p>
        <p id={`${id}-detail`} className="mt-0.5 text-sm text-muted-foreground">
          {props.detail}
        </p>
      </div>
      <Switch
        checked={props.checked}
        disabled={props.disabled}
        onChange={props.onChange}
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-detail`}
        className="mt-0.5"
      />
    </div>
  )
}

function PasswordForm({ userId }: { userId: string }) {
  const change = useServerFn(setPassword)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  return (
    <Section title="Password" description="Changing it signs you out everywhere else.">
      <form
        className="grid gap-4 px-5 py-4 sm:max-w-sm"
        onSubmit={async (e) => {
          e.preventDefault()
          const form = e.currentTarget
          const f = new FormData(form)
          setBusy(true)
          setResult(null)
          try {
            await change({ data: { id: userId, currentPassword: String(f.get('current')), password: String(f.get('password')) } })
            form.reset()
            setResult({ ok: true, text: 'Password changed. Other sign-ins were ended.' })
          } catch (err) {
            setResult({ ok: false, text: errorMessage(err, 'Couldn’t change it. Try again.') })
          } finally {
            setBusy(false)
          }
        }}
      >
        <Label>
          Current password
          <Input name="current" type="password" required autoComplete="current-password" />
        </Label>
        <Label>
          New password
          <Input name="password" type="password" required minLength={10} autoComplete="new-password" placeholder="At least 10 characters" />
        </Label>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={busy}>
            Change password
          </Button>
          {result && <Notice tone={result.ok ? 'success' : 'error'}>{result.text}</Notice>}
        </div>
      </form>
    </Section>
  )
}

