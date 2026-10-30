import { Link } from '@tanstack/react-router'
import { ArticleList, type ArticleLink } from './ArticleList.tsx'
import { CollectionIcon } from './CollectionIcon.tsx'
import { headingSlug } from '../lib/markdown.ts'
import { cn } from '../lib/cn.ts'

interface SectionData {
  category: string
  path: string | null
  articles: ArticleLink[]
  subsections: Array<{ name: string; path: string | null; articles: ArticleLink[]; description?: string }>
}

// Sections and their subsections. Folder-backed ones link to their own page
// (/articles/billing). `titled` false hides the top-level headings (a single
// unnamed section, or a section's own page). `current` is the page's own
// folder: on a subsection's page its name is already the page title, so it
// isn't repeated above its articles.
export function HelpSections({ sections, titled = true, current }: { sections: SectionData[]; titled?: boolean; current?: string }) {
  return (
    // One column that can't grow past the page: a plain grid column is as wide
    // as its widest line, and a truncated description still counts in full.
    <div className="grid grid-cols-1 gap-10">
      {sections.map((section) => (
        <section key={section.category} className="min-w-0" aria-labelledby={titled ? `cat-${headingSlug(section.category)}` : undefined}>
          {titled && (
            <h2 id={`cat-${headingSlug(section.category)}`} className="mb-3 scroll-mt-20 text-sm font-semibold text-muted-foreground">
              {section.path ? (
                <Link to="/articles/$" params={{ _splat: section.path }} className="hover:text-foreground hover:underline underline-offset-4">
                  {section.category}
                </Link>
              ) : (
                section.category
              )}
            </h2>
          )}
          {section.articles.length > 0 && <ArticleList articles={section.articles} />}
          {section.subsections.map((sub) =>
            sub.path === current ? (
              <ArticleList key={sub.name} articles={sub.articles} />
            ) : (
              <div key={sub.name} className="mt-5">
                <h3 className="mb-2 text-sm text-muted-foreground">
                  {sub.path ? (
                    <Link to="/articles/$" params={{ _splat: sub.path }} className="hover:text-foreground hover:underline underline-offset-4">
                      {sub.name}
                    </Link>
                  ) : (
                    sub.name
                  )}
                </h3>
                {sub.description && <p className="-mt-1 mb-2.5 text-sm text-muted-foreground/80">{sub.description}</p>}
                <ArticleList articles={sub.articles} />
              </div>
            ),
          )}
        </section>
      ))}
    </div>
  )
}

// The help center's front page: a card for each section (a public folder),
// with its icon, description and how many articles it has.
export function CollectionCards({ sections }: { sections: Array<{ category: string; path: string | null; description: string; icon: string | null; count: number }> }) {
  return (
    // Three across when there are enough; one or two cards stay centered under the search.
    <ul
      className={cn(
        'grid w-full grid-cols-1 gap-4',
        sections.length >= 3 ? 'sm:grid-cols-2 lg:grid-cols-3' : sections.length === 2 ? 'mx-auto max-w-3xl sm:grid-cols-2' : 'mx-auto max-w-sm',
      )}
    >
      {sections.map((s) =>
        s.path ? (
          <li key={s.path} className="min-w-0">
            <Link
              to="/articles/$"
              params={{ _splat: s.path }}
              className="flex h-full min-h-44 flex-col rounded-xl border border-border bg-card p-5 transition-colors hover:border-foreground/25 hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <CollectionIcon icon={s.icon} size={26} className="text-primary" />
              <h2 className="mt-4 font-semibold text-balance">{s.category}</h2>
              {s.description && <p className="mt-1 line-clamp-3 text-sm text-muted-foreground">{s.description}</p>}
              <p className="mt-auto pt-4 text-sm text-muted-foreground">
                {s.count} {s.count === 1 ? 'article' : 'articles'}
              </p>
            </Link>
          </li>
        ) : null,
      )}
    </ul>
  )
}
