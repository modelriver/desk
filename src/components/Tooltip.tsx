import { cloneElement, useEffect, useId, useLayoutEffect, useRef, useState, type FocusEvent, type MouseEvent, type PointerEvent, type ReactElement, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

// A small label for a control, shadcn style: inverted colours (black on a
// light page, white on a dark one), an arrow, and an optional key hint.
// Shown after a short hover, at once on keyboard focus, and at once when
// moving between controls while one is already showing. Hidden on click,
// Escape, scroll or leaving. The control keeps its own aria-label; the
// tooltip only repeats it visually (plus the hint), so it's aria-hidden.

const DELAY = 450
// Moving to another control soon after one showed skips the delay.
let lastHidden = 0
const WARM = 400

type Side = 'top' | 'bottom'
interface TriggerProps {
  onMouseEnter?: (e: MouseEvent<HTMLElement>) => void
  onMouseLeave?: (e: MouseEvent<HTMLElement>) => void
  onFocus?: (e: FocusEvent<HTMLElement>) => void
  onBlur?: (e: FocusEvent<HTMLElement>) => void
  onPointerDown?: (e: PointerEvent<HTMLElement>) => void
}

export function Tooltip({ content, shortcut, side = 'top', children }: { content: ReactNode; shortcut?: string; side?: Side; children: ReactElement<TriggerProps> }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const id = useId()

  const show = (el: HTMLElement, now: boolean) => {
    clearTimeout(timer.current)
    if (now || Date.now() - lastHidden < WARM) setAnchor(el)
    else timer.current = setTimeout(() => setAnchor(el), DELAY)
  }
  const hide = () => {
    clearTimeout(timer.current)
    setAnchor((a) => {
      if (a) lastHidden = Date.now()
      return null
    })
  }

  useEffect(() => {
    if (!anchor) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && hide()
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', hide, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', hide, true)
    }
  }, [anchor])
  useEffect(() => () => clearTimeout(timer.current), [])

  const p = children.props
  const trigger = cloneElement(children, {
    onMouseEnter: (e) => {
      p.onMouseEnter?.(e)
      show(e.currentTarget, false)
    },
    onMouseLeave: (e) => {
      p.onMouseLeave?.(e)
      hide()
    },
    onFocus: (e) => {
      p.onFocus?.(e)
      // Keyboard focus only: a click also focuses, and shouldn't pop a tooltip.
      if (e.currentTarget.matches(':focus-visible')) show(e.currentTarget, true)
    },
    onBlur: (e) => {
      p.onBlur?.(e)
      hide()
    },
    onPointerDown: (e) => {
      p.onPointerDown?.(e)
      hide()
    },
  })

  return (
    <>
      {trigger}
      {anchor && typeof document !== 'undefined' && createPortal(<Bubble id={id} anchor={anchor} side={side} content={content} shortcut={shortcut} />, document.body)}
    </>
  )
}

// "⌘S" on a Mac, "Ctrl+S" elsewhere.
export function shortcutLabel(key: string): string {
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
  return mac ? `⌘${key}` : `Ctrl+${key}`
}

function Bubble({ id, anchor, side, content, shortcut }: { id: string; anchor: HTMLElement; side: Side; content: ReactNode; shortcut?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState<{ x: number; y: number; side: Side; arrow: number } | null>(null)

  // Measured before paint: above the control (below if there's no room),
  // centred, kept inside the window with the arrow still on the control.
  // Re-measured each frame while showing, so it follows the control when the
  // page around it changes (a row moving, a list reloading); hidden if the
  // control goes away.
  useLayoutEffect(() => {
    let frame = 0
    let last = ''
    const measure = () => {
      const el = ref.current
      if (!el) return
      if (!anchor.isConnected) {
        if (last !== 'gone') setPlace(null)
        last = 'gone'
        return
      }
      const a = anchor.getBoundingClientRect()
      const { width, height } = el.getBoundingClientRect()
      const gap = 8
      const fits = side === 'top' ? a.top - height - gap > 4 : a.bottom + height + gap < window.innerHeight - 4
      const actual: Side = fits ? side : side === 'top' ? 'bottom' : 'top'
      const center = a.left + a.width / 2
      const x = Math.round(Math.min(Math.max(center - width / 2, 6), window.innerWidth - width - 6))
      const y = Math.round(actual === 'top' ? a.top - height - gap : a.bottom + gap)
      const key = `${x},${y},${actual},${width}`
      if (key !== last) {
        last = key
        setPlace({ x, y, side: actual, arrow: Math.min(Math.max(center - x, 10), width - 10) })
      }
      frame = requestAnimationFrame(measure)
    }
    measure()
    return () => cancelAnimationFrame(frame)
  }, [anchor, side, content])

  return (
    <div
      ref={ref}
      id={id}
      role="tooltip"
      aria-hidden="true"
      className="pointer-events-none fixed top-0 left-0 z-[100] flex max-w-64 items-center gap-2 rounded-md bg-foreground px-2.5 py-1.5 text-xs leading-snug font-medium text-background shadow-md"
      style={{ transform: place ? `translate(${place.x}px, ${place.y}px)` : undefined, visibility: place ? 'visible' : 'hidden' }}
    >
      <span>{content}</span>
      {shortcut && (
        <kbd className="rounded border border-background/25 px-1 font-sans text-[11px] leading-4 font-medium text-background/75">{shortcut}</kbd>
      )}
      <span
        aria-hidden="true"
        className="absolute size-2 rotate-45 bg-foreground"
        style={{ left: (place?.arrow ?? 0) - 4, ...(place?.side === 'bottom' ? { top: -4 } : { bottom: -4 }) }}
      />
    </div>
  )
}
