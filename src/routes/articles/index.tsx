import { useEffect, useState } from 'react'
import { createFileRoute, getRouteApi, Link, useRouterState } from '@tanstack/react-router'
import { getHelpIndex } from '../../functions/help.ts'
import { HelpBot } from '../../components/HelpBot.tsx'
import { CollectionCards, HelpSections } from '../../components/HelpSections.tsx'
import { SearchIcon, XIcon } from '../../components/icons.tsx'
import { Button } from '../../components/ui.tsx'
import { Highlight } from '../../components/Highlight.tsx'
import { headingSlug } from '../../lib/markdown.ts'
import { openChat } from '../../lib/chat-bus.ts'
import { cn } from '../../lib/cn.ts'
import { MAX_SEARCH_QUERY } from '../../lib/search.ts'
import { DEFAULT_CATEGORY } from '../../lib/content-core.ts'
import { articleDate } from '../../lib/article-date.ts'
import { articlesDescription, pageHead, ROBOTS_INDEX, ROBOTS_NOINDEX, siteFrom } from '../../lib/seo.ts'
import { ARTICLES_PATH } from '../../lib/help-path.ts'


// The help center: every article in its section, or search results for ?q=.
// The query lives in the URL, so results can be shared, bookmarked and server-rendered.
export const Route = createFileRoute('/articles/')({
  validateSearch: (search: Record<string, unknown>): { q?: string } =>
    typeof search.q === 'string' && search.q.trim() ? { q: search.q.slice(0, MAX_SEARCH_QUERY) } : {},
  loaderDeps: ({ search }) => ({ q: search.q ?? '' }),
  loader: ({ deps }) => getHelpIndex({ data: { q: deps.q } }),
  head: ({ loaderData, matches }) =>
    pageHead({
      ...siteFrom(matches),
      path: ARTICLES_PATH,
      title: loaderData?.query ? `Search: ${loaderData.query}` : 'Articles',
      description: articlesDescription(siteFrom(matches).brandName, sectionNames(loaderData?.sections)),
      keywords: [siteFrom(matches).brandName, 'help articles', 'guides', ...sectionNames(loaderData?.sections)],
      // Result pages are for people, not search engines.
      noindex: Boolean(loaderData?.query),
      breadcrumbs: [{ name: 'Home', path: '/' }],
    }),
  // The same rule for crawlers that read headers rather than the page.
  headers: ({ loaderData }) => ({ 'X-Robots-Tag': loaderData?.query ? ROBOTS_NOINDEX : ROBOTS_INDEX }),
  component: HelpIndex,
})

function HelpIndex() {
  const data = Route.useLoaderData()
  const { q = '' } = Route.useSearch()
  const navigate = Route.useNavigate()
  const loading = useRouterState({ select: (s) => s.isLoading })
  const [value, setValue] = useState(q)

  // Back/forward or a shared link changes the query: show it in the box.
  useEffect(() => {
    if (q !== value.trim()) setValue(q)
    // Only when the URL changes, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q])

  // Typing updates the URL (and so the results) after a short pause.
  useEffect(() => {
    const next = value.trim().slice(0, MAX_SEARCH_QUERY)
    if (next === q) return
    const timer = setTimeout(() => void navigate({ search: next ? { q: next } : {}, replace: true }), 200)
    return () => clearTimeout(timer)
  }, [value, q, navigate])

  // Sections that are folders get cards; articles outside any folder are listed below them.
  const collections = data.sections.filter((s) => s.path)
  const loose = data.sections.filter((s) => !s.path)

  return (
    <div className={cn('mx-auto px-4 pt-12 pb-24 sm:px-6', collections.length ? 'max-w-5xl' : 'max-w-3xl')}>
      {/* A centered column: heading, intro and search, with the cards below. */}
      <div className="mx-auto max-w-3xl">
        <h1 className="text-center font-serif text-3xl tracking-tight">Articles</h1>
        <p className="mt-2 text-center text-muted-foreground">Guides and answers to common questions.</p>

        <form
          role="search"
          className="relative mt-6 mb-8"
          onSubmit={(e) => {
            e.preventDefault()
            const next = value.trim().slice(0, MAX_SEARCH_QUERY)
            void navigate({ search: next ? { q: next } : {}, replace: true })
          }}
        >
          <label htmlFor="help-search" className="sr-only">
            Search articles
          </label>
          <SearchIcon size={17} className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            id="help-search"
            type="search"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            maxLength={MAX_SEARCH_QUERY}
            placeholder={`Search ${data.count} article${data.count === 1 ? '' : 's'}`}
            autoComplete="off"
            className="h-12 w-full rounded-xl border border-input bg-card pr-11 pl-10 text-base outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring [&::-webkit-search-cancel-button]:hidden"
          />
          {value && (
            <button
              type="button"
              onClick={() => setValue('')}
              aria-label="Clear search"
              className="absolute top-1/2 right-2 grid size-8 -translate-y-1/2 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <XIcon size={16} />
            </button>
          )}
        </form>
      </div>

      <div className={cn(loading && 'opacity-60')} aria-busy={loading || undefined}>
        {data.hits ? (
          <div className="mx-auto max-w-3xl">
            <SearchResults query={data.query} hits={data.hits} />
          </div>
        ) : data.limited ? (
          <p className="text-center text-sm text-muted-foreground">Too many searches in a short time. Please wait a minute.</p>
        ) : (
          <div className="grid grid-cols-1 gap-12">
            {collections.length > 0 && <CollectionCards sections={collections} />}
            {loose.length > 0 && (
              <div className="mx-auto w-full max-w-3xl min-w-0">
                <HelpSections sections={loose} titled={collections.length > 0 || loose.length > 1} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// Section names for the page's description and keywords; "General" (articles outside any folder) isn't one.
const sectionNames = (sections: Array<{ category: string }> | undefined) =>
  (sections ?? []).map((s) => s.category).filter((c) => c !== DEFAULT_CATEGORY)

type Hit = NonNullable<ReturnType<typeof Route.useLoaderData>['hits']>[number]

function SearchResults({ query, hits }: { query: string; hits: Hit[] }) {
  const { chatEnabled } = getRouteApi('__root__').useLoaderData()
  if (!hits.length) {
    return (
      <div className="flex flex-col items-start gap-4 rounded-xl border border-border bg-card p-6">
        <HelpBot body="figure" mood="thinking" size={72} className="-ml-1" />
        <div>
          <p className="font-medium">No articles match “{query}”.</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {chatEnabled ? 'Try other words, or ask the assistant: it can also connect you with our team.' : 'Try other words.'}
          </p>
        </div>
        {chatEnabled && (
          <Button variant="outline" onClick={() => openChat(query)}>
            <HelpBot size={20} />
            Ask the assistant
          </Button>
        )}
      </div>
    )
  }
  return (
    <div>
      <p className="mb-3 text-sm text-muted-foreground" role="status">
        {hits.length} {hits.length === 1 ? 'article' : 'articles'} for “{query}”
      </p>
      <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
        {hits.map((hit) => (
          <li key={hit.slug}>
            <Link
              to="/articles/$"
              params={{ _splat: hit.path }}
              hash={hit.heading ? headingSlug(hit.heading) : undefined}
              className="block px-4 py-3.5 hover:bg-muted/60"
            >
              <span className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium">
                  <Highlight text={hit.title} query={query} />
                </span>
                {hit.heading && (
                  <span className="text-sm text-muted-foreground">
                    › <Highlight text={hit.heading} query={query} />
                  </span>
                )}
              </span>
              <span className="mt-1 block text-sm text-muted-foreground">
                <Highlight text={hit.snippet} query={query} />
              </span>
              {(hit.category !== DEFAULT_CATEGORY || hit.modifiedAt) && (
                <span className="mt-1.5 block text-xs text-muted-foreground">
                  {hit.category !== DEFAULT_CATEGORY && hit.category}
                  {hit.category !== DEFAULT_CATEGORY && hit.modifiedAt && ' · '}
                  {hit.modifiedAt && <time dateTime={hit.modifiedAt}>Updated {articleDate(hit.modifiedAt)}</time>}
                </span>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
