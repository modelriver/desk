import { Link } from '@tanstack/react-router'
import { ChevronRightIcon, FileIcon } from './icons.tsx'
import { EmptyState } from './ui.tsx'
import { articleDate } from '../lib/article-date.ts'
import { cn } from '../lib/cn.ts'

export interface ArticleLink {
  slug: string
  path: string
  title: string
  description: string
  // When it was last updated, shown on the right.
  modifiedAt?: string
}

function Updated({ iso, className }: { iso: string; className: string }) {
  return (
    <time dateTime={iso} title={`Updated ${articleDate(iso, 'long')}`} className={cn('text-xs whitespace-nowrap text-muted-foreground tabular-nums', className)}>
      {articleDate(iso)}
    </time>
  )
}

export function ArticleList({ articles }: { articles: ArticleLink[] }) {
  if (!articles.length) {
    return (
      <EmptyState icon={<FileIcon />} title="No articles yet">
        Add Markdown files to the data folder’s <code>public/</code> directory, or upload them from the dashboard.
      </EmptyState>
    )
  }
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
      {articles.map((a) => (
        <li key={a.slug}>
          <Link to="/articles/$" params={{ _splat: a.path }} className="group flex items-center gap-4 px-4 py-3.5 hover:bg-muted/60">
            <FileIcon size={16} className="shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="block font-medium">{a.title}</span>
              {a.description && <span className="mt-0.5 block truncate text-sm text-muted-foreground">{a.description}</span>}
              {/* Phones: under the description, so the title keeps the width. */}
              {a.modifiedAt && <Updated iso={a.modifiedAt} className="mt-1 block sm:hidden" />}
            </span>
            {a.modifiedAt && <Updated iso={a.modifiedAt} className="hidden shrink-0 sm:block" />}
            <ChevronRightIcon size={16} className="shrink-0 text-muted-foreground" />
          </Link>
        </li>
      ))}
    </ul>
  )
}
