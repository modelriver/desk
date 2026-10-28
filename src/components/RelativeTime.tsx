import { useSyncExternalStore } from 'react'
import { fullDateTime, timeAgo, timeUntil } from '../lib/time.ts'

// One shared clock for every timestamp on the page, ticking every 5 seconds
// while anything is listening, so "seconds ago" labels stay current.
let now = Date.now()
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | undefined

function subscribe(listener: () => void) {
  listeners.add(listener)
  if (!timer) {
    now = Date.now()
    timer = setInterval(() => {
      now = Date.now()
      for (const l of listeners) l()
    }, 5000)
  }
  return () => {
    listeners.delete(listener)
    if (!listeners.size && timer) {
      clearInterval(timer)
      timer = undefined
    }
  }
}

// `future` for times ahead ("in 3 hours") instead of behind ("3 hours ago").
export function RelativeTime({ iso, className, future }: { iso: string; className?: string; future?: boolean }) {
  const current = useSyncExternalStore(
    subscribe,
    () => now,
    () => Date.now(),
  )
  return (
    // The server renders with its own clock and time zone; the browser
    // corrects both right after hydration.
    <time dateTime={iso} title={fullDateTime(iso)} className={className} suppressHydrationWarning>
      {future ? timeUntil(iso, current) : timeAgo(iso, current)}
    </time>
  )
}
