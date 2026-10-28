import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from './ui.tsx'
import { ArrowUpIcon, BookIcon, FolderIcon, LockIcon, RefreshIcon, UsersIcon, XIcon } from './icons.tsx'
import { RelativeTime } from './RelativeTime.tsx'
import { cn } from '../lib/cn.ts'
import { BusyIcon } from './BusyIcon.tsx'

// Dialogs for the Data page, on the native <dialog> (Escape, focus and the
// backdrop are handled by the browser).

function useModal(open: boolean) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (open && !el.open) el.showModal()
    if (!open && el.open) el.close()
  }, [open])
  return ref
}

const PANEL =
  'm-auto w-[min(28rem,calc(100vw-2rem))] max-w-none rounded-2xl border border-border bg-card p-0 text-foreground shadow-2xl backdrop:bg-black/40'

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  busy,
  tone = 'destructive',
  onConfirm,
  onClose,
}: {
  open: boolean
  title: string
  children: ReactNode
  confirmLabel: string
  busy?: boolean
  // destructive (the default): red, with Cancel focused so Enter does nothing
  // risky. primary: an everyday action like Publish, focused so Enter confirms.
  tone?: 'destructive' | 'primary'
  onConfirm: () => void
  onClose: () => void
}) {
  const ref = useModal(open)
  const primary = tone === 'primary'
  // showModal() focuses the first button (Cancel); an everyday action moves
  // focus to itself afterwards, so Enter confirms it.
  const confirmRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (open && primary) confirmRef.current?.focus()
  }, [open, primary])
  return (
    <dialog ref={ref} onClose={onClose} onClick={(e) => e.target === e.currentTarget && ref.current?.close()} aria-labelledby="confirm-title" className={PANEL}>
      {open && (
        <div className="p-6">
          <h2 id="confirm-title" className="text-base font-semibold">
            {title}
          </h2>
          <div className="mt-2 text-sm text-muted-foreground">{children}</div>
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => ref.current?.close()} autoFocus={!primary}>
              Cancel
            </Button>
            <Button
              variant={primary ? 'default' : 'destructive'}
              className={primary ? undefined : 'border border-destructive/30'}
              disabled={busy}
              onClick={onConfirm}
              ref={confirmRef}
            >
              <BusyIcon busy={busy} size={14} />
              {confirmLabel}
            </Button>
          </div>
        </div>
      )}
    </dialog>
  )
}

export interface FolderChoice {
  visibility: 'public' | 'private'
  path: string
  title: string
  depth: number
  // Why it can't be chosen (it's the item itself, or too deep), if so.
  disabled?: string
}

// "Move to…": the keyboard- and touch-friendly alternative to dragging.
export function MoveDialog({
  open,
  itemTitle,
  choices,
  current,
  busy,
  onMove,
  onClose,
}: {
  open: boolean
  itemTitle: string
  choices: FolderChoice[]
  current: { visibility: 'public' | 'private'; path: string } | null
  busy?: boolean
  onMove: (target: { visibility: 'public' | 'private'; path: string }) => void
  onClose: () => void
}) {
  const ref = useModal(open)
  const key = (c: { visibility: string; path: string }) => `${c.visibility}:${c.path}`
  const [picked, setPicked] = useState<string | null>(null)
  useEffect(() => {
    if (open) setPicked(null)
  }, [open])
  const choice = choices.find((c) => key(c) === picked)

  return (
    <dialog ref={ref} onClose={onClose} onClick={(e) => e.target === e.currentTarget && ref.current?.close()} aria-labelledby="move-title" className={PANEL}>
      {open && (
        <form
          className="flex max-h-[min(36rem,85dvh)] flex-col"
          onSubmit={(e) => {
            e.preventDefault()
            if (choice) onMove({ visibility: choice.visibility, path: choice.path })
          }}
        >
          <div className="flex items-start justify-between gap-4 px-6 pt-6">
            <h2 id="move-title" className="text-base font-semibold">
              Move “{itemTitle}”
            </h2>
            <Button variant="ghost" size="icon-sm" className="-mt-1 -mr-2" aria-label="Close" onClick={() => ref.current?.close()}>
              <XIcon />
            </Button>
          </div>
          <fieldset className="mt-3 flex-1 overflow-y-auto px-3">
            <legend className="sr-only">Destination folder</legend>
            {choices.map((c) => {
              const isCurrent = current !== null && key(c) === key(current)
              const disabled = Boolean(c.disabled) || isCurrent
              return (
                <label
                  key={key(c)}
                  style={{ paddingLeft: `${0.75 + c.depth * 1.25}rem` }}
                  className={cn(
                    'flex items-center gap-2.5 rounded-lg py-2 pr-3 text-sm',
                    disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-muted/70',
                    picked === key(c) && 'bg-muted',
                  )}
                  title={c.disabled ?? (isCurrent ? 'It’s already here' : undefined)}
                >
                  <input
                    type="radio"
                    name="target"
                    value={key(c)}
                    disabled={disabled}
                    checked={picked === key(c)}
                    onChange={() => setPicked(key(c))}
                    className="m-0 size-4 shrink-0 accent-[var(--primary)]"
                  />
                  {c.depth === 0 ? (
                    c.visibility === 'public' ? <BookIcon size={15} className="text-muted-foreground" /> : <LockIcon size={15} className="text-muted-foreground" />
                  ) : (
                    <FolderIcon size={15} className="text-muted-foreground" />
                  )}
                  <span className={cn('truncate', c.depth === 0 && 'font-medium')}>{c.title}</span>
                  {isCurrent && <span className="ml-auto text-xs text-muted-foreground">Current</span>}
                </label>
              )
            })}
          </fieldset>
          <div className="flex justify-end gap-2 border-t border-border px-6 py-4">
            <Button variant="ghost" onClick={() => ref.current?.close()}>
              Cancel
            </Button>
            <Button type="submit" disabled={!choice || busy}>
              <BusyIcon busy={busy} size={14} />
              Move here
            </Button>
          </div>
        </form>
      )}
    </dialog>
  )
}

// Someone else saved the article since it was opened. Two choices, each saying
// what happens to whose changes; Keep editing closes it and saves nothing.
export function ConflictDialog({
  open,
  busy,
  theirsAt,
  onReload,
  onOverwrite,
  onClose,
}: {
  open: boolean
  busy?: boolean
  // When their version was saved.
  theirsAt?: string | null
  onReload: () => void
  onOverwrite: () => void
  onClose: () => void
}) {
  const ref = useModal(open)
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === e.currentTarget && ref.current?.close()}
      aria-labelledby="conflict-title"
      aria-describedby="conflict-detail"
      className={PANEL}
    >
      {open && (
        <div className="p-6">
          <div className="flex items-start gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-full bg-muted text-foreground" aria-hidden="true">
              <UsersIcon size={17} />
            </span>
            <div className="min-w-0">
              <h2 id="conflict-title" className="text-base font-semibold">
                Someone else saved this article
              </h2>
              <p id="conflict-detail" className="mt-1 text-sm text-muted-foreground">
                {theirsAt ? (
                  <>
                    Their version was saved <RelativeTime iso={theirsAt} />, while you were editing. Choose which one to keep.
                  </>
                ) : (
                  'A newer version was saved while you were editing. Choose which one to keep.'
                )}
              </p>
            </div>
          </div>

          <div className="mt-5 grid gap-2" role="group" aria-label="Which version to keep">
            <ConflictChoice
              icon={<RefreshIcon size={16} />}
              title="Load their version"
              detail="See what they changed. Your edits stay backed up in this browser, so you can bring them back."
              onClick={onReload}
              autoFocus
            />
            <ConflictChoice
              icon=<BusyIcon busy={busy} size={16} idle={<ArrowUpIcon size={16} />} />
              title="Save mine over theirs"
              detail={<span className="text-destructive">Their changes will be lost.</span>}
              onClick={onOverwrite}
              disabled={busy}
              danger
            />
          </div>

          <div className="mt-5 flex justify-end">
            <Button variant="ghost" size="sm" onClick={() => ref.current?.close()}>
              Keep editing
            </Button>
          </div>
        </div>
      )}
    </dialog>
  )
}

// One choice in the conflict dialog: a full-width row, so the consequence is
// read before it's chosen, and nothing wraps on a small screen.
function ConflictChoice({
  icon,
  title,
  detail,
  onClick,
  disabled,
  danger,
  autoFocus,
}: {
  icon: ReactNode
  title: string
  detail: ReactNode
  onClick: () => void
  disabled?: boolean
  danger?: boolean
  autoFocus?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      autoFocus={autoFocus}
      className={cn(
        'flex w-full items-start gap-3 rounded-xl border border-border px-4 py-3 text-left hover:bg-muted/60 disabled:opacity-60',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        danger ? 'hover:border-destructive/40' : 'hover:border-input',
      )}
    >
      <span className={cn('mt-0.5 shrink-0', danger ? 'text-destructive' : 'text-foreground')}>{icon}</span>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{title}</span>
        <span className="mt-0.5 block text-sm text-muted-foreground">{detail}</span>
      </span>
    </button>
  )
}
