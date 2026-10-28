import { useState } from 'react'
import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { deleteUser, listUsers, resetUserTwoFactor, setPassword } from '../../functions/users.ts'
import { CopyIcon, KeyIcon, PlusIcon, ShieldIcon, TrashIcon } from '../../components/icons.tsx'
import { ActionsMenu } from '../../components/ActionsMenu.tsx'
import { Button, Input, Notice, PageHeader } from '../../components/ui.tsx'
import { AddMemberDialog } from '../../components/AddMemberDialog.tsx'
import { errorMessage } from '../../lib/errors.ts'
import { initials } from '../../lib/initials.ts'

export const Route = createFileRoute('/dashboard/users')({
  beforeLoad: ({ context }) => {
    if (context.user.role !== 'admin') throw redirect({ to: '/dashboard' })
  },
  loader: () => listUsers(),
  component: UsersPage,
})


function UsersPage() {
  const users = Route.useLoaderData()
  const { user: me } = Route.useRouteContext()
  const router = useRouter()
  const remove = useServerFn(deleteUser)
  const reset = useServerFn(setPassword)
  const resetTwoFactor = useServerFn(resetUserTwoFactor)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(false)

  const run = async (fn: () => Promise<string>) => {
    setBusy(true)
    setMessage(null)
    try {
      setMessage({ ok: true, text: await fn() })
      await router.invalidate()
      return true
    } catch (err) {
      setMessage({ ok: false, text: errorMessage(err, 'Something went wrong.') })
      return false
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageHeader
        title="Users"
        description="Everyone who can sign in to this dashboard."
        actions={
          <Button onClick={() => setAdding(true)}>
            <PlusIcon size={15} />
            Add member
          </Button>
        }
      />

      <AddMemberDialog open={adding} onClose={() => setAdding(false)} onAdded={() => void router.invalidate()} />

      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="flex items-baseline gap-2 text-sm font-medium">
          Team <span className="text-muted-foreground">{users.length}</span>
        </h2>
        {message && <Notice tone={message.ok ? 'success' : 'error'}>{message.text}</Notice>}
      </div>
      {/* No overflow-hidden here: row menus need to extend past the list. */}
      <ul className="divide-y divide-border rounded-xl border border-border bg-card">
        {users.map((u) => {
          const isMe = u.id === me.id
          return (
            <li key={u.id} className="px-4 py-3">
              <div className="flex items-center gap-3">
                <span className="grid size-9 shrink-0 place-items-center rounded-full bg-muted text-xs font-semibold text-muted-foreground">
                  {initials(u.name)}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 text-sm">
                    <span className="truncate font-medium">{u.name}</span>
                    {isMe && <span className="shrink-0 text-xs text-muted-foreground">You</span>}
                  </p>
                  <p className="truncate text-sm text-muted-foreground">
                    {u.email}
                    {!u.twoFactorEnabled && <span className="ml-2 text-xs text-destructive">Two-factor not set up yet</span>}
                  </p>
                </div>
                <span className="w-16 shrink-0 text-right text-sm text-muted-foreground capitalize max-sm:hidden">{u.role}</span>
                <ActionsMenu
                  label={`Actions for ${u.name}`}
                  items={[
                    {
                      label: isMe ? 'Change password' : 'Set password',
                      icon: <KeyIcon size={15} />,
                      onSelect: () => setEditing(u.id),
                    },
                    {
                      label: 'Copy email',
                      icon: <CopyIcon size={15} />,
                      onSelect: () => {
                        void navigator.clipboard?.writeText(u.email).then(
                          () => setMessage({ ok: true, text: `Copied ${u.email}.` }),
                          () => setMessage({ ok: false, text: 'Couldn’t copy. Select the email and copy it instead.' }),
                        )
                      },
                    },
                    ...(isMe
                      ? []
                      : [
                          ...(u.twoFactorEnabled
                            ? [
                                {
                                  label: 'Reset two-factor',
                                  icon: <ShieldIcon size={15} />,
                                  disabled: busy,
                                  onSelect: () => {
                                    if (
                                      confirm(
                                        `Reset two-factor authentication for ${u.name}? They’re signed out now and set it up again at their next sign-in.`,
                                      )
                                    ) {
                                      void run(
                                        async () => (
                                          await resetTwoFactor({ data: { id: u.id } }),
                                          `Two-factor reset for ${u.name}. They’ll set it up at their next sign-in.`
                                        ),
                                      )
                                    }
                                  },
                                },
                              ]
                            : []),
                          'separator' as const,
                          {
                            label: 'Remove from team',
                            icon: <TrashIcon size={15} />,
                            destructive: true,
                            disabled: busy,
                            onSelect: () => {
                              if (confirm(`Remove ${u.name} (${u.email})? They are signed out immediately.`)) {
                                void run(async () => (await remove({ data: { id: u.id } }), `Removed ${u.name}.`))
                              }
                            },
                          },
                        ]),
                  ]}
                />
              </div>
              {editing === u.id && (
                <form
                  className="mt-3 flex flex-wrap items-center gap-2 pl-12"
                  onSubmit={(e) => {
                    e.preventDefault()
                    const form = new FormData(e.currentTarget)
                    const password = String(form.get('password'))
                    const currentPassword = isMe ? String(form.get('currentPassword')) : undefined
                    void run(async () => {
                      await reset({ data: { id: u.id, password, currentPassword } })
                      return isMe
                        ? 'Your password was changed. You were signed out everywhere else.'
                        : `New password set for ${u.name}. They were signed out.`
                    }).then((ok) => ok && setEditing(null))
                  }}
                >
                  {isMe && (
                    <Input
                      name="currentPassword"
                      type="password"
                      required
                      autoFocus
                      autoComplete="current-password"
                      placeholder="Current password"
                      aria-label="Current password"
                      className="h-8 max-w-xs"
                    />
                  )}
                  <Input
                    name="password"
                    type="password"
                    minLength={10}
                    required
                    autoFocus={!isMe}
                    autoComplete="new-password"
                    placeholder="New password, at least 10 characters"
                    aria-label={isMe ? 'New password' : `New password for ${u.name}`}
                    className="h-8 max-w-xs"
                  />
                  <Button type="submit" size="sm" disabled={busy}>
                    Save password
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>
                    Cancel
                  </Button>
                </form>
              )}
            </li>
          )
        })}
      </ul>
    </>
  )
}

