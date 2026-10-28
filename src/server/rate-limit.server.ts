// Sliding-window limiter kept in memory. Resets on restart and isn't shared
// between processes, which is fine for a single-process app; put a shared
// store here if you run several instances.

export interface Limit {
  key: string
  max: number
  windowMs: number
}

const hits = new Map<string, number[]>()
const MAX_KEYS = 50_000

// Allows the request only if every limit has room, and records the hit only
// then. A request rejected by one limit (say, its own IP's) never uses up
// another (say, the site-wide budget). A max of 0 means "no limit".
export function allowAll(limits: Limit[], now = Date.now()): boolean {
  const active = limits.filter((l) => l.max > 0)
  const windows = active.map((l) => (hits.get(l.key) ?? []).filter((t) => t > now - l.windowMs))
  // Rejected requests store nothing, so a flood of them (say, sign-ins with
  // random emails) can't grow the map.
  if (active.some((l, i) => windows[i]!.length >= l.max)) return false
  active.forEach((l, i) => {
    windows[i]!.push(now)
    // Re-inserted so the map's order runs from least to most recently used.
    hits.delete(l.key)
    hits.set(l.key, windows[i]!)
  })
  if (hits.size > MAX_KEYS) prune(now)
  return true
}

export function allow(key: string, max: number, windowMs: number, now = Date.now()): boolean {
  return allowAll([{ key, max, windowMs }], now)
}

// Drop keys with no recent hits (every window used here is at most a day),
// then, if it's still too big, the least recently used ones, so a burst of
// distinct keys can't make every request pay for a full scan.
function prune(now: number) {
  for (const [key, ts] of hits) {
    if (!ts.length || ts[ts.length - 1]! <= now - 86_400_000) hits.delete(key)
  }
  const target = Math.floor(MAX_KEYS * 0.9)
  for (const key of hits.keys()) {
    if (hits.size <= target) break
    hits.delete(key)
  }
}

// How many requests a key let through in the last `windowMs`, without
// counting one. Used by Settings to show how much of the AI budget is used.
export function rateLimitHits(key: string, windowMs: number, now = Date.now()): number {
  return (hits.get(key) ?? []).filter((t) => t > now - windowMs).length
}

// For tests.
export function rateLimitKeyCount(): number {
  return hits.size
}

export function resetRateLimits() {
  hits.clear()
}
