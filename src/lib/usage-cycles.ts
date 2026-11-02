// Monthly credit cycles, counted the way ModelRiver counts them: each starts
// at 00:00 UTC on the anchor's day of the month, or on the month's last day
// when the month is shorter (a Jan 31 anchor gives Feb 28, then Mar 31).

export interface Cycle {
  // YYYY-MM-DD, UTC. `end` is the next cycle's start.
  start: string
  end: string
}

function startIn(year: number, month: number, day: number): string {
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  return new Date(Date.UTC(year, month, Math.min(day, last))).toISOString().slice(0, 10)
}

// From the cycle starting at `currentStart` back to the first one that
// overlaps `since` (YYYY-MM, when the install was set up), newest first, with
// at most `max` earlier cycles (ModelRiver reports 24).
export function recentCycles(anchor: string, currentStart: string, since: string, max = 24): Cycle[] {
  const day = new Date(anchor).getUTCDate()
  const current = new Date(currentStart)
  const year = current.getUTCFullYear()
  const month = current.getUTCMonth()
  const cycles: Cycle[] = []
  for (let i = 0; i <= max; i++) {
    const cycle = { start: startIn(year, month - i, day), end: startIn(year, month - i + 1, day) }
    if (i > 0 && cycle.end <= `${since}-01`) break
    cycles.push(cycle)
  }
  return cycles
}

const DAY = { month: 'short', day: 'numeric', timeZone: 'UTC' } as const
const DAY_YEAR = { ...DAY, year: 'numeric' } as const

// "Nov 30" for a YYYY-MM-DD date or ISO timestamp, in UTC.
export function formatCycleDay(date: string): string {
  return new Date(date.length === 10 ? `${date}T00:00:00Z` : date).toLocaleDateString('en', DAY)
}

// "Oct 30 – Nov 30, 2026", or "Dec 30, 2026 – Jan 30, 2027" across a new year.
export function cycleLabel({ start, end }: Cycle): string {
  const [from, to] = [new Date(`${start}T00:00:00Z`), new Date(`${end}T00:00:00Z`)]
  const sameYear = from.getUTCFullYear() === to.getUTCFullYear()
  return `${from.toLocaleDateString('en', sameYear ? DAY : DAY_YEAR)} – ${to.toLocaleDateString('en', DAY_YEAR)}`
}
