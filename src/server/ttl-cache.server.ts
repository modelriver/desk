// Tiny in-memory cache with a time-to-live and in-flight de-duplication: many
// concurrent callers for the same key share one load.

export class TtlCache<T> {
  private entries = new Map<string, { value: Promise<T>; expires: number }>()
  private ttlMs: number
  private maxEntries: number

  constructor(ttlMs: number, maxEntries = 5_000) {
    this.ttlMs = ttlMs
    this.maxEntries = maxEntries
  }

  get(key: string, load: () => Promise<T>, now = Date.now()): Promise<T> {
    const hit = this.entries.get(key)
    if (hit && hit.expires > now) return hit.value
    const value = load()
    this.entries.set(key, { value, expires: now + this.ttlMs })
    // Failures are not cached: the next caller tries again.
    value.catch(() => {
      if (this.entries.get(key)?.value === value) this.entries.delete(key)
    })
    if (this.entries.size > this.maxEntries) this.evictExpired(now)
    return value
  }

  delete(key: string) {
    this.entries.delete(key)
  }

  clear() {
    this.entries.clear()
  }

  private evictExpired(now: number) {
    for (const [key, entry] of this.entries) if (entry.expires <= now) this.entries.delete(key)
    // Still too big (all fresh): drop the oldest inserted.
    for (const key of this.entries.keys()) {
      if (this.entries.size <= this.maxEntries) break
      this.entries.delete(key)
    }
  }
}
