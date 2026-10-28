import { useEffect, useRef, useState, type ReactNode } from 'react'
import { delayedFlag } from '../lib/delayed-flag.ts'
import { SpinnerIcon } from './icons.tsx'

// `busy`, but only once it has lasted long enough to be worth a spinner (see
// delayed-flag.ts). Quick actions never show one.
export function useDelayedBusy(busy: boolean): boolean {
  const [shown, setShown] = useState(false)
  const flag = useRef<ReturnType<typeof delayedFlag> | null>(null)
  flag.current ??= delayedFlag(setShown)
  useEffect(() => {
    flag.current!.set(busy)
  }, [busy])
  useEffect(() => () => flag.current?.dispose(), [])
  return shown
}

// A spinner for slow actions; otherwise `idle` (an icon, or nothing).
export function BusyIcon({ busy, size = 14, idle = null }: { busy?: boolean | null; size?: number; idle?: ReactNode }) {
  return useDelayedBusy(Boolean(busy)) ? <SpinnerIcon size={size} /> : <>{idle}</>
}
