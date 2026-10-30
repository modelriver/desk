import { useId, useRef, useState } from 'react'
import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { getMyAccount, removeMyAvatar, setMyNotifications, uploadMyAvatar } from '../../functions/account.ts'
import { prepareAvatar } from '../../lib/image-prepare.ts'
import { initials } from '../../lib/initials.ts'
import { BusyIcon } from '../../components/BusyIcon.tsx'
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
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
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
          <ProfilePicture account={account} onChange={setAccount} />
        </Section>

        <Notifications account={account} isAdmin={user.role === 'admin'} onSaved={setAccount} />
        <PasswordForm userId={user.id} />
      </div>
    </>
  )
}

// The picture visitors see beside your replies in the chat, instead of the bot.
function ProfilePicture({ account, onChange }: { account: Account; onChange: (a: Account) => void }) {
  const upload = useServerFn(uploadMyAvatar)
  const remove = useServerFn(removeMyAvatar)
  const router = useRouter()
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (action: () => Promise<Account>) => {
    setBusy(true)
    setError(null)
    try {
      onChange(await action())
      // The sidebar's account row shows it too.
      await router.invalidate()
    } catch (err) {
      setError(errorMessage(err, 'Couldn’t save the picture. Please try again.'))
    } finally {
      setBusy(false)
    }
  }
  const pick = (file: File | undefined) => {
    if (input.current) input.current.value = ''
    if (!file) return
    void run(async () => {
      const form = new FormData()
      form.set('file', await prepareAvatar(file), 'avatar.webp')
      return upload({ data: form })
    })
  }

  return (
    <div className="flex flex-wrap items-center gap-4 px-5 py-4">
      {account.avatar ? (
        <img src={account.avatar} alt="" className="size-12 shrink-0 rounded-full object-cover" />
      ) : (
        <span className="grid size-12 shrink-0 place-items-center rounded-full bg-muted text-sm font-medium text-muted-foreground" aria-hidden="true">
          {initials(account.name)}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">Profile picture</p>
        <p className="mt-0.5 text-sm text-muted-foreground">Shown to visitors beside your replies in the chat. A square photo works best; it’s cropped to the middle.</p>
        {error && (
          <div className="mt-1.5">
            <Notice tone="error">{error}</Notice>
          </div>
        )}
      </div>
      <div className="flex items-center gap-2">
        {account.avatar && (
          <Button variant="ghost-destructive" size="sm" disabled={busy} onClick={() => void run(() => remove())}>
            Remove
          </Button>
        )}
        <Button variant="outline" size="sm" disabled={busy} onClick={() => input.current?.click()}>
          <BusyIcon busy={busy} size={14} />
          {account.avatar ? 'Change' : 'Upload'}
        </Button>
        <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => pick(e.target.files?.[0])} />
      </div>
    </div>
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

