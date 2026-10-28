import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from './ui.tsx'
import { cn } from '../lib/cn.ts'
import { BusyIcon } from './BusyIcon.tsx'

// A small confirmation that opens next to the button that asked for it,
// instead of a browser dialog. `children` is that button; the parent decides
// when it's open. Closes on Cancel, Escape or a click elsewhere, and opens
// upward when there isn't room below (like ActionsMenu).
export function ConfirmPopover({
  open,
  title,
  message,
  confirmLabel,
  busy,
  onConfirm,
  onCancel,
  children,
}: {
  open: boolean
  title: string
  message: ReactNode
  confirmLabel: string
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
  children: ReactNode
}) {
  const root = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const cancelButton = useRef<HTMLButtonElement>(null)
  const [openUp, setOpenUp] = useState(false)

  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const anchor = root.current?.getBoundingClientRect()
      const height = (panel.current?.offsetHeight ?? 0) + 8
      if (!anchor) return
      const below = window.innerHeight - anchor.bottom
      setOpenUp(below < height && anchor.top > below)
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  // Focus starts on Cancel, the safe choice.
  useEffect(() => {
    if (!open) return
    cancelButton.current?.focus({ preventScroll: true })
    const onPointer = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) onCancel()
    }
    document.addEventListener('pointerdown', onPointer)
    return () => document.removeEventListener('pointerdown', onPointer)
  }, [open, onCancel])

  const cancel = () => {
    onCancel()
    root.current?.querySelector<HTMLElement>('button')?.focus()
  }

  return (
    <div ref={root} className="relative">
      {children}
      {open && (
        <div
          ref={panel}
          role="alertdialog"
          aria-label={title}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              cancel()
            }
          }}
          className={cn(
            'absolute right-0 z-40 w-72 rounded-lg border border-border bg-card p-3.5 text-left shadow-lg shadow-black/10',
            openUp ? 'bottom-full mb-1.5' : 'top-full mt-1.5',
          )}
        >
          <p className="text-sm font-medium">{title}</p>
          <p className="mt-1 text-sm text-muted-foreground">{message}</p>
          <div className="mt-3 flex justify-end gap-2">
            <Button ref={cancelButton} variant="ghost" size="sm" onClick={cancel}>
              Cancel
            </Button>
            <Button variant="destructive" size="sm" className="border border-destructive/30" disabled={busy} onClick={onConfirm}>
              <BusyIcon busy={busy} size={14} />
              {confirmLabel}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
