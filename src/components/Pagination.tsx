import type { ReactNode } from 'react'
import { Link, type LinkProps } from '@tanstack/react-router'
import { buttonClass } from './ui.tsx'
import { cn } from '../lib/cn.ts'
import { ChevronRightIcon } from './icons.tsx'
import { pageLinks } from '../lib/paging.ts'

// "26–50 of 312", with Previous and Next and the page numbers near this one.
// Pages are links (?page=3), so a page can be reloaded or shared. Hidden
// when everything fits on one page.
export function Pagination({
  page,
  pages,
  total,
  pageSize,
  link,
  noun,
}: {
  page: number
  pages: number
  total: number
  pageSize: number
  // Where page `n` is.
  link: (n: number) => LinkProps
  // "conversations", "messages"
  noun: string
}) {
  if (pages <= 1) return null
  const first = (page - 1) * pageSize + 1
  const last = Math.min(total, page * pageSize)
  return (
    <nav aria-label="Pages" className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm">
      <p className="text-muted-foreground tabular-nums">
        {first}–{last} of {total} {noun}
      </p>
      <div className="flex items-center gap-1">
        <PageLink to={page > 1 ? link(page - 1) : null} label="Previous page">
          <ChevronRightIcon size={15} className="rotate-180" />
          <span className="max-sm:sr-only">Previous</span>
        </PageLink>
        {pageLinks(page, pages).map((n, i) =>
          n === null ? (
            <span key={`gap-${i}`} className="px-1 text-muted-foreground" aria-hidden="true">
              …
            </span>
          ) : (
            <Link
              key={n}
              {...link(n)}
              aria-label={`Page ${n}`}
              aria-current={n === page ? 'page' : undefined}
              className={cn(buttonClass(n === page ? 'secondary' : 'ghost', 'sm'), 'min-w-8 justify-center tabular-nums max-sm:hidden')}
            >
              {n}
            </Link>
          ),
        )}
        <PageLink to={page < pages ? link(page + 1) : null} label="Next page">
          <span className="max-sm:sr-only">Next</span>
          <ChevronRightIcon size={15} />
        </PageLink>
      </div>
    </nav>
  )
}

function PageLink({ to, label, children }: { to: LinkProps | null; label: string; children: ReactNode }) {
  const className = cn(buttonClass('ghost', 'sm'), 'gap-1')
  if (!to) {
    return (
      <span aria-disabled="true" aria-label={label} className={cn(className, 'pointer-events-none opacity-40')}>
        {children}
      </span>
    )
  }
  return (
    <Link {...to} aria-label={label} className={className}>
      {children}
    </Link>
  )
}
