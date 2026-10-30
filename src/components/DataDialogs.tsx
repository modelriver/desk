import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from './ui.tsx'
import { ArrowUpIcon, BookIcon, FileIcon, FolderIcon, LockIcon, PencilIcon, RefreshIcon, SearchIcon, UsersIcon, XIcon } from './icons.tsx'
import { RelativeTime } from './RelativeTime.tsx'
import { cn } from '../lib/cn.ts'
import { BusyIcon } from './BusyIcon.tsx'
import { Tooltip } from './Tooltip.tsx'
import { CollectionIcon } from './CollectionIcon.tsx'
import { DEFAULT_COLLECTION_ICON, ICON_LABELS, isCollectionIcon, MAX_FOLDER_DESCRIPTION, searchIcons } from '../lib/collection-icons.ts'

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
  'm-auto w-[min(28rem,calc(100vw-2rem))] max-w-none rounded-2xl border border-border bg-card p-0 text-foreground backdrop:bg-black/40'

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  busy,
  tone = 'destructive',
  icon,
  items,
  note,
  onConfirm,
  onClose,
}: {
  open: boolean
  title: string
  // What happens, in a sentence or two.
  children: ReactNode
  confirmLabel: string
  busy?: boolean
  // destructive (the default): red, with Cancel focused so Enter does nothing
  // risky. primary: an everyday action like Publish, focused so Enter confirms.
  tone?: 'destructive' | 'primary'
  // Shown in a tile beside the title, in the tone's color.
  icon?: ReactNode
  // What it acts on, listed under the explanation (a few, then a count).
  items?: string[]
  // A smaller line after the list.
  note?: ReactNode
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
  const shown = items?.slice(0, LISTED) ?? []
  const more = (items?.length ?? 0) - shown.length
  return (
    <dialog ref={ref} onClose={onClose} onClick={(e) => e.target === e.currentTarget && ref.current?.close()} aria-labelledby="confirm-title" className={PANEL}>
      {open && (
        <>
          {/* Icon, title and explanation, stacked. */}
          <div className="px-6 pt-6 pb-5">
            {icon && (
              <span
                aria-hidden="true"
                className={cn('mb-4 grid size-10 place-items-center rounded-full', primary ? 'bg-muted text-foreground' : 'bg-destructive/10 text-destructive')}
              >
                {icon}
              </span>
            )}
            <div className="min-w-0">
              <h2 id="confirm-title" className="text-base font-semibold">
                {title}
              </h2>
              <div className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{children}</div>
              {shown.length > 0 && (
                <ul className="mt-4 max-h-60 divide-y divide-border overflow-y-auto rounded-lg border border-border text-sm">
                  {shown.map((item, i) => (
                    <li key={`${i}-${item}`} className="flex items-center gap-2.5 px-3 py-1.5">
                      <FileIcon size={14} className="shrink-0 text-muted-foreground" />
                      <span className="min-w-0 truncate">{item}</span>
                    </li>
                  ))}
                  {more > 0 && <li className="px-3 py-1.5 text-muted-foreground">and {more} more</li>}
                </ul>
              )}
              {note && <p className="mt-3 text-xs text-muted-foreground">{note}</p>}
            </div>
          </div>
          <div className="flex justify-end gap-2 rounded-b-2xl border-t border-border bg-muted/40 px-6 py-3.5">
            <Button variant="outline" onClick={() => ref.current?.close()} autoFocus={!primary}>
              Cancel
            </Button>
            <Button variant={primary ? 'default' : 'danger'} disabled={busy} onClick={onConfirm} ref={confirmRef}>
              <BusyIcon busy={busy} size={14} />
              {confirmLabel}
            </Button>
          </div>
        </>
      )}
    </dialog>
  )
}

// How many items a confirmation lists by name before "and N more".
const LISTED = 6

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

// A help-center section's card: a short description and an icon, previewed
// as visitors will see it. The icon is edited on the card itself: click it
// for a small searchable picker. The folder's name (and so its URL) isn't touched.
export function FolderDetailsDialog({
  folder,
  articles,
  busy,
  onSave,
  onClose,
}: {
  folder: { title: string; description: string; icon: string | null } | null
  // Published articles in it, for the preview's count.
  articles: number
  busy?: boolean
  onSave: (details: { description: string; icon: string | null }) => void
  onClose: () => void
}) {
  const open = folder !== null
  const ref = useModal(open)
  const [description, setDescription] = useState('')
  const [icon, setIcon] = useState<string | null>(null)
  useEffect(() => {
    if (!folder) return
    setDescription(folder.description)
    setIcon(folder.icon)
  }, [folder])
  const left = MAX_FOLDER_DESCRIPTION - description.length

  return (
    <dialog ref={ref} onClose={onClose} onClick={(e) => e.target === e.currentTarget && ref.current?.close()} aria-labelledby="details-title" className={PANEL}>
      {folder && (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            onSave({ description: description.trim(), icon })
          }}
        >
          <div className="flex items-start justify-between gap-4 px-6 pt-6">
            <div>
              <h2 id="details-title" className="text-base font-semibold">
                {folder.title}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">Its card on the help center. Click the icon to change it.</p>
            </div>
            <Button variant="ghost" size="icon-sm" className="-mt-1 -mr-2" aria-label="Close" onClick={() => ref.current?.close()}>
              <XIcon />
            </Button>
          </div>

          <div className="space-y-5 px-6 pt-5 pb-6">
            {/* The card as visitors will see it, with the icon editable in place. */}
            <div className="flex min-h-40 flex-col rounded-xl border border-border bg-card p-5">
              <IconPicker icon={icon} onPick={setIcon} />
              <p className="mt-3 font-semibold">{folder.title}</p>
              {description.trim() ? (
                <p className="mt-1 line-clamp-3 text-sm text-muted-foreground">{description.trim()}</p>
              ) : (
                <p className="mt-1 text-sm text-muted-foreground/60 italic">No description</p>
              )}
              <p className="mt-auto pt-4 text-xs text-muted-foreground">
                {articles} {articles === 1 ? 'article' : 'articles'}
              </p>
            </div>

            <div>
              <div className="flex items-baseline justify-between gap-3">
                <label htmlFor="folder-description" className="text-sm font-medium">
                  Description
                </label>
                <span className={cn('text-xs tabular-nums', left < 0 ? 'text-destructive' : 'text-muted-foreground')} aria-live="polite">
                  {left < 20 ? `${left} left` : ''}
                </span>
              </div>
              <textarea
                id="folder-description"
                value={description}
                onChange={(e) => setDescription(e.target.value.replace(/\n/g, ' '))}
                maxLength={MAX_FOLDER_DESCRIPTION}
                rows={2}
                placeholder="What’s in this section, in a line: “Plans, invoices, refunds and taxes”"
                className="mt-1.5 w-full resize-none rounded-md border border-input bg-card px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring"
              />
            </div>
          </div>

          <div className="flex justify-end gap-2 rounded-b-2xl border-t border-border bg-muted/40 px-6 py-3.5">
            <Button variant="outline" onClick={() => ref.current?.close()}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || left < 0}>
              <BusyIcon busy={busy} size={14} />
              Save
            </Button>
          </div>
        </form>
      )}
    </dialog>
  )
}

// The card's icon, in a dashed box with a pencil: click for a small picker
// right below it, with a search. Picking closes it; so do Escape (without
// closing the dialog) and a click outside.
function IconPicker({ icon, onPick }: { icon: string | null; onPick: (name: string) => void }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const shown = isCollectionIcon(icon) ? icon : DEFAULT_COLLECTION_ICON
  const matches = searchIcons(query)

  useEffect(() => {
    if (!open) return
    const onPointer = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointer)
    return () => document.removeEventListener('pointerdown', onPointer)
  }, [open])

  const close = () => {
    setOpen(false)
    trigger.current?.focus()
  }

  return (
    <div ref={root} className="relative self-start">
      <Tooltip content="Change the icon">
        <button
          ref={trigger}
          type="button"
          onClick={() => {
            setQuery('')
            setOpen((o) => !o)
          }}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={`Icon: ${ICON_LABELS[shown]}. Change it`}
          className={cn(
            'group/icon relative grid size-14 place-items-center rounded-xl border border-dashed text-primary',
            'hover:border-foreground/40 hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
            open ? 'border-foreground/50 bg-muted/50' : 'border-border',
          )}
        >
          <CollectionIcon icon={shown} size={26} />
          <span className="absolute -right-1.5 -bottom-1.5 grid size-5 place-items-center rounded-full border border-border bg-card text-muted-foreground group-hover/icon:text-foreground">
            <PencilIcon size={11} />
          </span>
        </button>
      </Tooltip>

      {open && (
        <div
          role="dialog"
          aria-label="Choose an icon"
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return
            // Close the picker only, not the dialog around it.
            e.preventDefault()
            e.stopPropagation()
            close()
          }}
          className="absolute top-full left-0 z-20 mt-2 w-[min(19rem,calc(100vw-4rem))] rounded-xl border border-border bg-card p-2"
        >
          <div className="relative">
            <SearchIcon size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                // Enter picks the first match instead of saving the dialog.
                if (e.key !== 'Enter') return
                e.preventDefault()
                if (matches[0]) {
                  onPick(matches[0])
                  close()
                }
              }}
              placeholder="Search: billing, team…"
              aria-label="Search icons"
              className="h-8 w-full rounded-md border border-input bg-background pr-2 pl-8 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring"
            />
          </div>
          {matches.length ? (
            <div role="listbox" aria-label="Icons" className="mt-2 grid max-h-44 grid-cols-7 gap-0.5 overflow-y-auto">
              {matches.map((name) => (
                <button
                  key={name}
                  type="button"
                  role="option"
                  aria-selected={shown === name}
                  title={ICON_LABELS[name]}
                  aria-label={ICON_LABELS[name]}
                  onClick={() => {
                    onPick(name)
                    close()
                  }}
                  className={cn(
                    'grid aspect-square place-items-center rounded-md focus-visible:outline-2 focus-visible:outline-ring',
                    shown === name ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  <CollectionIcon icon={name} size={18} />
                </button>
              ))}
            </div>
          ) : (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">No icons match “{query.trim()}”.</p>
          )}
        </div>
      )}
    </div>
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
