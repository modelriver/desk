import { Fragment } from 'react'
import { Link } from '@tanstack/react-router'
import { ChevronRightIcon } from './icons.tsx'

// The trail above a help-center page: Home › Articles › its sections, then the
// page itself (not a link). Matches the BreadcrumbList in the page's head.
export interface Crumb {
  label: string
  // Help-center links: the front page, /articles (with a section's anchor) or a folder's page.
  to: '/' | '/articles' | { folder: string } | { hash: string }
}

export function Breadcrumbs({ trail, current }: { trail: Crumb[]; current: string }) {
  const crumbs: Crumb[] = [{ label: 'Home', to: '/' }, { label: 'Articles', to: '/articles' }, ...trail]
  return (
    <nav aria-label="Breadcrumb">
      <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-muted-foreground">
        {crumbs.map((c) => (
          <Fragment key={`${c.label}:${JSON.stringify(c.to)}`}>
            <li>
              <CrumbLink crumb={c} />
            </li>
            <li aria-hidden="true" className="flex">
              <ChevronRightIcon size={14} className="opacity-60" />
            </li>
          </Fragment>
        ))}
        <li aria-current="page" className="max-w-[16rem] truncate text-foreground/80">
          {current}
        </li>
      </ol>
    </nav>
  )
}

function CrumbLink({ crumb }: { crumb: Crumb }) {
  const className = 'hover:text-foreground'
  if (crumb.to === '/') return <Link to="/" className={className}>{crumb.label}</Link>
  if (crumb.to === '/articles') return <Link to="/articles" className={className}>{crumb.label}</Link>
  if ('folder' in crumb.to)
    return (
      <Link to="/articles/$" params={{ _splat: crumb.to.folder }} className={className}>
        {crumb.label}
      </Link>
    )
  return (
    <Link to="/articles" hash={crumb.to.hash} className={className}>
      {crumb.label}
    </Link>
  )
}
