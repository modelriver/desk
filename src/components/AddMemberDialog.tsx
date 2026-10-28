import { useEffect, useRef, useState } from 'react'
import { useServerFn } from '@tanstack/react-start'
import { createUser } from '../functions/users.ts'
import { Button, Input, Label, Notice } from './ui.tsx'
import { CopyIcon, XIcon } from './icons.tsx'
import { cn } from '../lib/cn.ts'
import { BusyIcon } from './BusyIcon.tsx'
import { errorMessage } from '../lib/errors.ts'

type Role = 'agent' | 'admin'
type Added = Awaited<ReturnType<typeof createUser>>

const ROLES: Array<{ value: Role; title: string; detail: string }> = [
  { value: 'agent', title: 'Agent', detail: 'Answers conversations: reads them, takes over from the AI and replies.' },
  { value: 'admin', title: 'Admin', detail: 'Everything an agent does, plus the data folder, the team and settings.' },
]

// Adding someone to the team, in a native <dialog> (Escape, focus and the
// backdrop are handled by the browser). After adding, the same dialog shows
// their temporary password once, to copy and pass on.
export function AddMemberDialog({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const nameField = useRef<HTMLInputElement>(null)
  const create = useServerFn(createUser)
  const [role, setRole] = useState<Role>('agent')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [added, setAdded] = useState<Added | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const el = dialog.current
    if (!el) return
    if (open && !el.open) {
      // Start fresh each time it opens.
      setRole('agent')
      setError(null)
      setAdded(null)
      setCopied(false)
      el.showModal()
      // showModal focuses the first button (the close ×); start on the name instead.
      nameField.current?.focus()
    }
    if (!open && el.open) el.close()
  }, [open])

  const close = () => dialog.current?.close()

  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      // Clicking the backdrop closes it, except while the password is showing, so it isn't lost by accident.
      onClick={(e) => e.target === e.currentTarget && !added && close()}
      aria-labelledby="add-member-title"
      className="m-auto w-[min(28rem,calc(100vw-2rem))] max-w-none rounded-2xl border border-border bg-card p-0 text-foreground shadow-2xl backdrop:bg-black/40"
    >
      {open && (
        <div className="p-6">
          <div className="flex items-start justify-between gap-4">
            <h2 id="add-member-title" className="text-base font-semibold">
              {added ? `${added.name} is on the team` : 'Add a team member'}
            </h2>
            <Button variant="ghost" size="icon-sm" className="-mt-1 -mr-2" aria-label="Close" onClick={close}>
              <XIcon />
            </Button>
          </div>

          {added ? (
            <div className="mt-2">
              <p className="text-sm text-muted-foreground">
                Added as {added.role === 'admin' ? 'an admin' : 'an agent'}. Send them this temporary password privately,
                with the sign-in address. It’s shown only this once; they set up two-factor when they first sign in and can
                change the password after.
              </p>
              <div className="mt-4 flex items-center gap-2">
                <code className="min-w-0 flex-1 rounded-md border border-border bg-muted/50 px-3 py-2 text-center font-mono text-sm select-all">
                  {added.temporaryPassword}
                </code>
                <Button variant="outline" onClick={() => void navigator.clipboard?.writeText(added.temporaryPassword).then(() => setCopied(true))}>
                  <CopyIcon size={14} />
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
              <div className="mt-6 flex justify-end">
                <Button onClick={close} autoFocus>
                  Done
                </Button>
              </div>
            </div>
          ) : (
            <form
              className="mt-4 grid gap-4"
              onSubmit={async (e) => {
                e.preventDefault()
                const f = new FormData(e.currentTarget)
                setBusy(true)
                setError(null)
                try {
                  setAdded(await create({ data: { name: String(f.get('name')), email: String(f.get('email')), role } }))
                  onAdded()
                } catch (err) {
                  setError(errorMessage(err, 'Couldn’t add them. Try again.'))
                } finally {
                  setBusy(false)
                }
              }}
            >
              <Label>
                Name
                <Input ref={nameField} name="name" required autoComplete="off" maxLength={100} />
              </Label>
              <Label>
                Email
                <Input name="email" type="email" required autoComplete="off" maxLength={200} />
              </Label>
              <fieldset className="grid gap-2">
                <legend className="mb-1.5 text-sm font-medium">Role</legend>
                {ROLES.map((r) => (
                  <label
                    key={r.value}
                    className={cn(
                      'flex cursor-pointer items-start gap-3 rounded-lg border p-3',
                      role === r.value ? 'border-primary bg-accent/50' : 'border-border hover:bg-muted/60',
                    )}
                  >
                    <input
                      type="radio"
                      name="role"
                      value={r.value}
                      checked={role === r.value}
                      onChange={() => setRole(r.value)}
                      // 16px radio, 2px down: centred on the 20px title line.
                      className="m-0 mt-0.5 size-4 shrink-0 accent-[var(--primary)]"
                    />
                    <span>
                      <span className="block text-sm font-medium">{r.title}</span>
                      <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{r.detail}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
              <p className="text-xs text-muted-foreground">
                A temporary password is created for them; you’ll see it on the next step.
              </p>
              {error && <Notice tone="error">{error}</Notice>}
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={close}>
                  Cancel
                </Button>
                <Button type="submit" disabled={busy}>
                  <BusyIcon busy={busy} size={14} />
                  Add member
                </Button>
              </div>
            </form>
          )}
        </div>
      )}
    </dialog>
  )
}
