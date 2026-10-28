// Relative times written out in full: "just now", "45 seconds ago",
// "1 minute ago", "3 hours ago", "yesterday", "4 days ago", then a date.
// Fixed to English so the server render and the browser agree.

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'} ago`
}

export function timeAgo(iso: string, now = Date.now()): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  // A timestamp slightly in the future (clock skew) still reads as "just now".
  const seconds = Math.max(0, Math.floor((now - then) / 1000))
  if (seconds < 10) return 'just now'
  if (seconds < 60) return plural(seconds, 'second')
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return plural(minutes, 'minute')
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return plural(hours, 'hour')
  const days = Math.floor(hours / 24)
  if (days === 1) return 'yesterday'
  if (days < 7) return plural(days, 'day')
  return new Date(iso).toLocaleDateString('en', { day: 'numeric', month: 'short', year: 'numeric' })
}

// The other direction, for things scheduled ahead: "in 45 minutes",
// "in 21 hours", "in 3 days". Anything due now or overdue reads "soon".
export function timeUntil(iso: string, now = Date.now()): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const minutes = Math.floor((then - now) / 60_000)
  if (minutes < 1) return 'soon'
  const unit = (n: number, u: string) => `in ${n} ${u}${n === 1 ? '' : 's'}`
  if (minutes < 60) return unit(minutes, 'minute')
  // Rounded, so a deadline 23 h 59 min away reads "in 24 hours".
  const hours = Math.round(minutes / 60)
  if (hours < 48) return unit(hours, 'hour')
  return unit(Math.round(hours / 24), 'day')
}

// Full date and time for tooltips, in the viewer's own time zone.
export function fullDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en', { dateStyle: 'full', timeStyle: 'short' })
}
