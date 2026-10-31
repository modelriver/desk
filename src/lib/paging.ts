// Pages of 25 for the dashboard's lists (Conversations, Archived, Tickets).

export const PAGE_SIZE = 25

// ?page= from a URL or a request: a whole number from 1, else 1.
export function pageNumber(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
  return Number.isInteger(n) && n >= 1 && n <= 100_000 ? n : 1
}

// Where a page starts, with a page past the end moved back to the last one
// (after the last row on it was archived, say).
export function pageOf(total: number, page: number) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const current = Math.min(page, pages)
  return { page: current, pages, total, pageSize: PAGE_SIZE, offset: (current - 1) * PAGE_SIZE }
}

// 1 … 4 5 6 … 12: the first, the last, and this page's neighbours.
export function pageLinks(page: number, pages: number): Array<number | null> {
  const show = new Set([1, pages, page - 1, page, page + 1].filter((n) => n >= 1 && n <= pages))
  const sorted = [...show].sort((a, b) => a - b)
  const out: Array<number | null> = []
  sorted.forEach((n, i) => {
    if (i > 0 && n - sorted[i - 1]! > 1) out.push(n - sorted[i - 1]! === 2 ? n - 1 : null)
    out.push(n)
  })
  return out
}
