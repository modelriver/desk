import { useEffect, useRef, useState } from 'react'
import { useServerFn } from '@tanstack/react-start'
import { openTicket } from '../functions/tickets.ts'
import { Button, Input, Label, Notice, Textarea } from './ui.tsx'
import { XIcon } from './icons.tsx'
import { BusyIcon } from './BusyIcon.tsx'
import { errorMessage } from '../lib/errors.ts'
import { subjectFrom, TICKET_LIMITS } from '../lib/ticket-core.ts'

// Opening a ticket by hand, in a native <dialog> like Add member: for a call
// or an email, or from a chat (`fromChat`: the visitor's name and verified
// email are filled in on the server, the message prefilled with their last one).
export function NewTicketDialog({
  open,
  onClose,
  onCreated,
  fromChat,
}: {
  open: boolean
  onClose: () => void
  onCreated: (ref: string) => void
  fromChat?: { sessionId: string; visitorName: string | null; lastMessage: string }
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const firstField = useRef<HTMLInputElement>(null)
  const create = useServerFn(openTicket)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const el = dialog.current
    if (!el) return
    if (open && !el.open) {
      setError(null)
      el.showModal()
      firstField.current?.focus()
    }
    if (!open && el.open) el.close()
  }, [open])

  const close = () => dialog.current?.close()

  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      onClick={(e) => e.target === e.currentTarget && close()}
      aria-labelledby="new-ticket-title"
      className="m-auto w-[min(32rem,calc(100vw-2rem))] max-w-none rounded-2xl border border-border bg-card p-0 text-foreground backdrop:bg-black/40"
    >
      {open && (
        <div className="p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 id="new-ticket-title" className="text-base font-semibold">
                {fromChat ? 'Turn this chat into a ticket' : 'New ticket'}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {fromChat
                  ? 'For something that needs a follow-up by email. The ticket links back to this chat.'
                  : 'For a request that came by phone, email or anywhere else. Replies go to the customer by email.'}
              </p>
            </div>
            <Button variant="ghost" size="icon-sm" className="-mt-1 -mr-2" aria-label="Close" onClick={close}>
              <XIcon />
            </Button>
          </div>

          <form
            className="mt-4 grid gap-4"
            onSubmit={async (e) => {
              e.preventDefault()
              const f = new FormData(e.currentTarget)
              setBusy(true)
              setError(null)
              try {
                const res = await create({
                  data: {
                    name: String(f.get('name') ?? ''),
                    email: String(f.get('email') ?? ''),
                    subject: String(f.get('subject')),
                    text: String(f.get('text')),
                    sessionId: fromChat?.sessionId ?? null,
                  },
                })
                close()
                onCreated(res.ref)
              } catch (err) {
                setError(errorMessage(err, 'Couldn’t open the ticket. Try again.'))
              } finally {
                setBusy(false)
              }
            }}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Label>
                Customer’s name
                <Input
                  ref={firstField}
                  name="name"
                  defaultValue={fromChat?.visitorName ?? ''}
                  required={!fromChat}
                  maxLength={60}
                  autoComplete="off"
                />
              </Label>
              <Label>
                Email
                <Input
                  name="email"
                  type="email"
                  maxLength={254}
                  autoComplete="off"
                  placeholder={fromChat ? 'Their verified email, if any' : 'For replies'}
                />
              </Label>
            </div>
            <Label>
              Subject
              <Input name="subject" required maxLength={TICKET_LIMITS.subject} defaultValue={fromChat?.lastMessage ? subjectFrom(fromChat.lastMessage) : ''} />
            </Label>
            <Label>
              What they need
              <Textarea name="text" required maxLength={TICKET_LIMITS.body} defaultValue={fromChat?.lastMessage ?? ''} className="min-h-28 resize-y" />
            </Label>
            {error && <Notice tone="error">{error}</Notice>}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={close}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                <BusyIcon busy={busy} size={14} />
                Open ticket
              </Button>
            </div>
          </form>
        </div>
      )}
    </dialog>
  )
}

