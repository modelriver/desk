import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { MoreIcon } from './icons.tsx'
import { Tooltip } from './Tooltip.tsx'
import { buttonClass } from './ui.tsx'
import { cn } from '../lib/cn.ts'

export type MenuItem =
  | { label: string; icon?: ReactNode; onSelect: () => void; destructive?: boolean; disabled?: boolean }
  | 'separator'

// A "⋯" button with a small dropdown of row actions. Opens instantly,
// closes on outside click, Escape or after choosing an item, and supports
// arrow keys between items. Opens upward when there isn't room below.
export function ActionsMenu({ label, items }: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const [openUp, setOpenUp] = useState(false)
  const menuId = useId()

  // Measured before paint, so the menu never flashes in the wrong place.
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const button = trigger.current?.getBoundingClientRect()
      const height = (menu.current?.offsetHeight ?? 0) + 8
      if (!button) return
      const below = window.innerHeight - button.bottom
      setOpenUp(below < height && button.top > below)
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  const menuItems = () => [...(root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])]

  useEffect(() => {
    if (!open) return
    menuItems()[0]?.focus({ preventScroll: true })
    const onPointer = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointer)
    return () => document.removeEventListener('pointerdown', onPointer)
  }, [open])

  const close = (refocus = true) => {
    setOpen(false)
    if (refocus) trigger.current?.focus()
  }

  return (
    <div ref={root} className="relative">
      <Tooltip content="More actions">
      <button
        ref={trigger}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((o) => !o)}
        className={buttonClass('ghost', 'icon-sm', cn('text-muted-foreground hover:text-foreground', open && 'bg-muted text-foreground'))}
      >
        <MoreIcon size={16} />
      </button>
      </Tooltip>
      {open && (
        <div
          ref={menu}
          id={menuId}
          role="menu"
          aria-label={label}
          onKeyDown={(e) => {
            const list = menuItems()
            const i = list.indexOf(document.activeElement as HTMLElement)
            if (e.key === 'Escape') {
              e.preventDefault()
              close()
            } else if (e.key === 'ArrowDown') {
              e.preventDefault()
              list[(i + 1) % list.length]?.focus()
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              list[(i - 1 + list.length) % list.length]?.focus()
            } else if (e.key === 'Tab') {
              close(false)
            }
          }}
          className={cn(
            'absolute right-0 z-40 min-w-48 rounded-lg border border-border bg-card p-1 shadow-lg shadow-black/10',
            openUp ? 'bottom-full mb-1' : 'top-full mt-1',
          )}
        >
          {items.map((item, i) =>
            item === 'separator' ? (
              <div key={`sep-${i}`} role="separator" className="my-1 h-px bg-border" />
            ) : (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                onClick={() => {
                  close(false)
                  item.onSelect()
                }}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-muted focus-visible:bg-muted disabled:opacity-50',
                  item.destructive ? 'text-destructive hover:bg-destructive/10 focus-visible:bg-destructive/10' : 'text-foreground',
                )}
              >
                {item.icon && <span className={cn('shrink-0', !item.destructive && 'text-muted-foreground')}>{item.icon}</span>}
                {item.label}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  )
}
