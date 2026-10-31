import type { CSSProperties } from 'react'
import { cn } from '../lib/cn.ts'

// A green tick in a ring that draws itself in (see .success-tick in
// styles.css): for a verified email or a raised ticket. Decorative; the text
// beside it says what happened.
export function SuccessTick({ size = 44, className }: { size?: number; className?: string }) {
  return (
    <svg
      data-motion=""
      className={cn('success-tick shrink-0 text-success', className)}
      width={size}
      height={size}
      viewBox="0 0 52 52"
      aria-hidden="true"
      focusable="false"
    >
      <circle data-motion="" className="tick-tint" cx="26" cy="26" r="24" fill="currentColor" fillOpacity="0.12" />
      <circle
        data-motion=""
        className="tick-ring"
        cx="26"
        cy="26"
        r="24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        transform="rotate(-90 26 26)"
        style={{ '--len': 151 } as CSSProperties}
      />
      <path
        data-motion=""
        className="tick-check"
        d="M16 27l7 7 13-15"
        fill="none"
        stroke="currentColor"
        strokeWidth="3.25"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ '--len': 31 } as CSSProperties}
      />
    </svg>
  )
}
