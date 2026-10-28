// When to show a "busy" spinner. Most actions finish in a few hundred
// milliseconds, and a spinner that appears for 50 ms reads as a flicker. So it
// only shows once something has taken longer than `delay`, and once shown it
// stays at least `minimum`, so it never blinks on and straight off again.

export const SPINNER_DELAY_MS = 400
export const SPINNER_MINIMUM_MS = 500

export interface Clock {
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (id: unknown) => void
  now: () => number
}

const realClock: Clock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
}

// Feed it the real busy state with set(); it calls onChange(shown) when the
// spinner should appear or go.
export function delayedFlag(
  onChange: (shown: boolean) => void,
  { delay = SPINNER_DELAY_MS, minimum = SPINNER_MINIMUM_MS, clock = realClock }: { delay?: number; minimum?: number; clock?: Clock } = {},
) {
  let shown = false
  let shownAt = 0
  let timer: unknown = null
  const cancel = () => {
    if (timer !== null) clock.clearTimeout(timer)
    timer = null
  }
  const show = () => {
    timer = null
    shown = true
    shownAt = clock.now()
    onChange(true)
  }
  const hide = () => {
    timer = null
    shown = false
    onChange(false)
  }
  return {
    set(busy: boolean) {
      cancel()
      if (busy) {
        // Already showing (perhaps waiting out its minimum): keep it.
        if (!shown) timer = clock.setTimeout(show, delay)
        return
      }
      if (!shown) return
      const left = minimum - (clock.now() - shownAt)
      if (left <= 0) hide()
      else timer = clock.setTimeout(hide, left)
    },
    dispose: cancel,
  }
}
