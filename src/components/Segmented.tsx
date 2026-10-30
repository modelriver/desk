import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '../lib/cn.ts'

// A small switch between a few views (Write / Markdown, All / Drafts). The
// highlight slides to the chosen option, quickly; it starts in place, and
// people who ask for less motion get no slide.

export interface SegmentedOption<T extends string> {
  value: T
  label: ReactNode
}

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  size = 'md',
  className,
}: {
  // What it switches, for screen readers ("Editing mode").
  label: string
  value: T
  options: Array<SegmentedOption<T>>
  onChange: (value: T) => void
  size?: 'sm' | 'md'
  className?: string
}) {
  const group = useRef<HTMLDivElement>(null)
  const [thumb, setThumb] = useState<{ left: number; width: number } | null>(null)
  // No slide on the first paint, only from one option to another.
  const [ready, setReady] = useState(false)

  useLayoutEffect(() => {
    const place = () => {
      const active = group.current?.querySelector<HTMLElement>('[aria-checked="true"]')
      if (active) setThumb({ left: active.offsetLeft, width: active.offsetWidth })
    }
    place()
    const id = requestAnimationFrame(() => setReady(true))
    if (!group.current) return () => cancelAnimationFrame(id)
    // Labels can change width (a count), so follow them.
    const observer = new ResizeObserver(place)
    observer.observe(group.current)
    return () => {
      cancelAnimationFrame(id)
      observer.disconnect()
    }
  }, [value, options.length])

  return (
    <div ref={group} role="radiogroup" aria-label={label} className={cn('relative inline-flex rounded-md bg-muted p-0.5', className)}>
      {thumb && (
        <span
          aria-hidden="true"
          data-motion=""
          className={cn(
            'absolute top-0.5 bottom-0.5 left-0 rounded-[5px] border border-border bg-card',
            ready && 'transition-[transform,width] duration-150 ease-out motion-reduce:transition-none',
          )}
          style={{ transform: `translateX(${thumb.left}px)`, width: thumb.width }}
        />
      )}
      {options.map((option) => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => !active && onChange(option.value)}
            data-motion=""
            className={cn(
              'relative z-10 flex items-center gap-1.5 rounded-[5px] font-medium whitespace-nowrap transition-colors duration-150 motion-reduce:transition-none',
              'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring',
              size === 'sm' ? 'h-7 px-2.5 text-[13px]' : 'h-8 px-3 text-sm',
              active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
