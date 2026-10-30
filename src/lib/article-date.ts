// An article's date as readers see it ("Oct 29, 2026", or "October 29, 2026"
// in full). In UTC, so the server and every browser print the same day and
// the page hydrates without a mismatch.
export function articleDate(iso: string, month: 'short' | 'long' = 'short'): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString('en', { day: 'numeric', month, year: 'numeric', timeZone: 'UTC' })
}
