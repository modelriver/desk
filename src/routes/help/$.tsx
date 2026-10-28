import { useEffect, useMemo, useState } from 'react'
import { createFileRoute, Link, notFound, redirect } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { getHelpPage, voteArticle } from '../../functions/help.ts'
import { Markdown } from '../../components/Markdown.tsx'
import { ArticleList } from '../../components/ArticleList.tsx'
import { HelpSections } from '../../components/HelpSections.tsx'
import { HelpBot } from '../../components/HelpBot.tsx'
import { Button } from '../../components/ui.tsx'
import { articleOutline, headingSlug, type OutlineEntry } from '../../lib/markdown.ts'
import { openChat } from '../../lib/chat-bus.ts'
import { hasLeadingH1 } from '../../lib/article-file.ts'
import { cn } from '../../lib/cn.ts'
import { folderOf } from '../../lib/help-path.ts'
import { errorMessage } from '../../lib/errors.ts'
import { DEFAULT_CATEGORY } from '../../lib/content-core.ts'

// A table of contents is worth it from this many sections.
const MIN_OUTLINE = 3

// /help/<section>, /help/<section>/<subsection> and /help/<folders…>/<article>.
export const Route = createFileRoute('/help/$')({
  loader: async ({ params }) => {
    const page = await getHelpPage({ data: { path: params._splat ?? '' } })
    if (!page) throw notFound()
    // An old or moved article link: send it (and search engines) to where it is now.
    if (page.kind === 'redirect') throw redirect({ to: '/help/$', params: { _splat: page.path }, statusCode: 301 })
    return page
  },
  head: ({ loaderData: a }) => {
    if (!a) return {}
    const url = a.site.url ? `${a.site.url}/help/${a.path}` : null
    if (a.kind === 'section') {
      return {
        meta: [{ title: `${a.title} | ${a.site.brandName}` }, { property: 'og:title', content: a.title }, ...(url ? [{ property: 'og:url', content: url }] : [])],
        links: url ? [{ rel: 'canonical', href: url }] : [],
      }
    }
    const title = `${a.title} | ${a.site.brandName}`
    return {
      meta: [
        { title },
        { name: 'description', content: a.description },
        { property: 'og:type', content: 'article' },
        { property: 'og:title', content: a.title },
        { property: 'og:description', content: a.description },
        { property: 'og:site_name', content: a.site.brandName },
        ...(url ? [{ property: 'og:url', content: url }] : []),
        { property: 'article:modified_time', content: a.modifiedAt },
        { property: 'article:section', content: a.category },
        { name: 'twitter:card', content: 'summary' },
      ],
      links: url ? [{ rel: 'canonical', href: url }] : [],
    }
  },
  component: HelpPage,
})

function HelpPage() {
  const page = Route.useLoaderData()
  if (page.kind === 'section') return <SectionPage section={page} />
  if (page.kind === 'article') return <ArticlePage article={page} />
  return null
}

type Loaded = ReturnType<typeof Route.useLoaderData>
type SectionData = Extract<Loaded, { kind: 'section' }>
type ArticleData = Extract<Loaded, { kind: 'article' }>

// A section's (or subsection's) own page: its articles, grouped as on /help.
function SectionPage({ section }: { section: SectionData }) {
  return (
    <div className="mx-auto max-w-[44rem] px-4 pt-10 pb-24 sm:px-6">
      <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
        <Link to="/help" className="hover:text-foreground">
          Articles
        </Link>
        {section.parent && (
          <>
            <span aria-hidden="true">/</span>
            <Link to="/help/$" params={{ _splat: section.parent.path }} className="hover:text-foreground">
              {section.parent.title}
            </Link>
          </>
        )}
      </nav>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight">{section.title}</h1>
      <p className="mt-1 mb-8 text-sm text-muted-foreground">
        {section.count} {section.count === 1 ? 'article' : 'articles'}
      </p>
      <HelpSections sections={section.sections} titled={false} />
    </div>
  )
}

function ArticlePage({ article }: { article: ArticleData }) {
  const outline = useMemo(() => articleOutline(article.body), [article.body])
  const withToc = outline.length >= MIN_OUTLINE
  const sectionPath = folderOf(article.path, 1)
  const subsectionPath = folderOf(article.path, 2)
  const updated = new Date(article.modifiedAt).toLocaleDateString('en', { day: 'numeric', month: 'long', year: 'numeric' })

  return (
    <div
      className={cn(
        'mx-auto px-4 pt-10 pb-24 sm:px-6',
        withToc ? 'max-w-5xl lg:grid lg:grid-cols-[minmax(0,44rem)_13rem] lg:justify-between lg:gap-12' : 'max-w-[44rem]',
      )}
    >
      <div className="min-w-0">
        <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
          <Link to="/help" className="hover:text-foreground">
            Articles
          </Link>
          {article.category !== DEFAULT_CATEGORY && (
            <>
              <span aria-hidden="true">/</span>
              {sectionPath ? (
                <Link to="/help/$" params={{ _splat: sectionPath }} className="hover:text-foreground">
                  {article.category}
                </Link>
              ) : (
                <Link to="/help" hash={`cat-${headingSlug(article.category)}`} className="hover:text-foreground">
                  {article.category}
                </Link>
              )}
            </>
          )}
          {article.subcategory && subsectionPath && (
            <>
              <span aria-hidden="true">/</span>
              <Link to="/help/$" params={{ _splat: subsectionPath }} className="hover:text-foreground">
                {article.subcategory}
              </Link>
            </>
          )}
        </nav>
        <p className="mt-2 text-xs text-muted-foreground">
          Updated <time dateTime={article.modifiedAt}>{updated}</time>
        </p>

        {withToc && (
          <details className="mt-6 rounded-xl border border-border bg-card px-4 py-3 lg:hidden">
            <summary className="cursor-pointer text-sm font-medium">On this page</summary>
            <Outline entries={outline} className="mt-3" />
          </details>
        )}

        <article className="prose prose-article mt-8">
          {/* Articles written in the editor keep their title in front matter, not as a heading. */}
          {!hasLeadingH1(article.body) && <h1>{article.title}</h1>}
          <Markdown source={article.body} className="prose-article" />
        </article>

        <Feedback slug={article.slug} initial={article.myVote} />

        {article.related.length > 0 && (
          <section aria-labelledby="related" className="mt-12">
            <h2 id="related" className="mb-3 text-sm font-semibold text-muted-foreground">
              Related articles
            </h2>
            <ArticleList articles={article.related} />
          </section>
        )}

        <aside className="mt-12 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border bg-card px-5 py-4">
          <div>
            <p className="font-medium">Still stuck?</p>
            <p className="text-sm text-muted-foreground">Ask a question and get an answer in a few seconds.</p>
          </div>
          <Button variant="outline" onClick={() => openChat()}>
            <HelpBot size={20} />
            Ask a question
          </Button>
        </aside>
      </div>

      {withToc && (
        <aside className="hidden lg:block">
          <nav aria-label="On this page" className="sticky top-24">
            <p className="mb-3 text-xs font-semibold text-muted-foreground">On this page</p>
            <Outline entries={outline} tracked />
          </nav>
        </aside>
      )}
    </div>
  )
}

// The article's sections. `tracked` highlights the one being read.
function Outline({ entries, tracked, className }: { entries: OutlineEntry[]; tracked?: boolean; className?: string }) {
  const active = useActiveSection(tracked ? entries.map((e) => e.id) : [])
  return (
    <ul className={cn('grid gap-1.5 text-sm', className)}>
      {entries.map((e) => (
        <li key={e.id} className={e.level === 3 ? 'pl-3' : undefined}>
          <a
            href={`#${e.id}`}
            aria-current={active === e.id ? 'location' : undefined}
            className={cn(
              'block leading-snug text-muted-foreground hover:text-foreground',
              active === e.id && 'font-medium text-foreground',
            )}
          >
            {e.text}
          </a>
        </li>
      ))}
    </ul>
  )
}

// The section heading nearest the top of the screen.
function useActiveSection(ids: string[]): string | null {
  const [active, setActive] = useState<string | null>(null)
  const key = ids.join(' ')
  useEffect(() => {
    if (!ids.length) return
    const visible = new Map<string, number>()
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.set(e.target.id, e.boundingClientRect.top)
          else visible.delete(e.target.id)
        }
        const top = [...visible.entries()].sort((a, b) => a[1] - b[1])[0]
        if (top) setActive(top[0])
      },
      // A band across the upper part of the screen, below the sticky header.
      { rootMargin: '-80px 0px -60% 0px' },
    )
    for (const id of ids) {
      const el = document.getElementById(id)
      if (el) observer.observe(el)
    }
    return () => observer.disconnect()
    // `key` stands in for `ids`, which is a new array each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return active
}

// "Was this helpful?" One vote per browser per article; it can be changed.
function Feedback({ slug, initial }: { slug: string; initial: boolean | null }) {
  const vote = useServerFn(voteArticle)
  const [value, setValue] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const choose = async (helpful: boolean) => {
    setBusy(true)
    setError(null)
    try {
      await vote({ data: { slug, helpful } })
      setValue(helpful)
    } catch (err) {
      setError(errorMessage(err, 'Couldn’t save that. Try again.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-labelledby="feedback" className="mt-12 border-t border-border pt-6">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="feedback" className="text-sm font-medium">
          Was this article helpful?
        </h2>
        <div className="flex gap-2">
          {([true, false] as const).map((helpful) => (
            <Button
              key={String(helpful)}
              variant="outline"
              size="sm"
              disabled={busy}
              aria-pressed={value === helpful}
              className={cn(value === helpful && 'border-foreground bg-muted')}
              onClick={() => void choose(helpful)}
            >
              {helpful ? 'Yes' : 'No'}
            </Button>
          ))}
        </div>
      </div>
      <p className="mt-2 min-h-5 text-sm text-muted-foreground" role="status">
        {error ? (
          <span className="text-destructive">{error}</span>
        ) : value === true ? (
          'Thanks for letting us know.'
        ) : value === false ? (
          'Thanks. We’ll use this to improve the article. The assistant below can help in the meantime.'
        ) : null}
      </p>
    </section>
  )
}
