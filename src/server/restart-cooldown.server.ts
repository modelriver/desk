// How long a visitor must wait before starting a new chat after ending one.
// The first restart is free; after that each restart within the hour waits
// longer (60 s, 2 min, 4 min, ... up to 15 min), counted from the last end.
// Kept in memory: resets on restart and isn't shared between processes,
// like the other rate limits.

const WINDOW_MS = 60 * 60_000
const BASE_SECONDS = 60
const MAX_SECONDS = 15 * 60

const ends = new Map<string, number[]>()

export function cooldownSeconds(endTimes: number[], freeRestarts: number, now: number): number {
  const recent = endTimes.filter((t) => t > now - WINDOW_MS)
  const penalized = recent.length - freeRestarts
  if (penalized <= 0) return 0
  const cooldown = Math.min(BASE_SECONDS * 2 ** (penalized - 1), MAX_SECONDS)
  const last = Math.max(...recent)
  return Math.max(0, Math.ceil((last + cooldown * 1000 - now) / 1000))
}

function recent(key: string, now: number): number[] {
  const list = (ends.get(key) ?? []).filter((t) => t > now - WINDOW_MS)
  if (list.length) ends.set(key, list)
  else ends.delete(key)
  return list
}

export interface RestartKeys {
  // Per browser (a long-lived HttpOnly cookie): the main rule.
  device: string | null
  // Per IP: a looser backstop for visitors who clear their cookies. A few free
  // restarts so people sharing an office IP don't slow each other down.
  ip: string
}

const DEVICE_FREE = 1
const IP_FREE = 3

export function recordEnd(keys: RestartKeys, now = Date.now()) {
  for (const key of keyList(keys)) ends.set(key, [...recent(key, now), now])
  if (ends.size > 50_000) {
    for (const key of ends.keys()) recent(key, now)
  }
}

export function restartWaitSeconds(keys: RestartKeys, now = Date.now()): number {
  return Math.max(
    keys.device ? cooldownSeconds(recent(`device:${keys.device}`, now), DEVICE_FREE, now) : 0,
    cooldownSeconds(recent(`ip:${keys.ip}`, now), IP_FREE, now),
  )
}

function keyList(keys: RestartKeys): string[] {
  return [...(keys.device ? [`device:${keys.device}`] : []), `ip:${keys.ip}`]
}

export function resetCooldowns() {
  ends.clear()
}
