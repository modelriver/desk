import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createFileRoute, getRouteApi, notFound, redirect } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { getHelpPage, voteArticle } from '../../functions/help.ts'
import { Markdown } from '../../components/Markdown.tsx'
import { ArticleList } from '../../components/ArticleList.tsx'
import { HelpSections } from '../../components/HelpSections.tsx'
import { CollectionIcon } from '../../components/CollectionIcon.tsx'
import { Breadcrumbs } from '../../components/Breadcrumbs.tsx'
import { HelpBot } from '../../components/HelpBot.tsx'
import { Button } from '../../components/ui.tsx'
import { articleOutline, headingSlug, type OutlineEntry } from '../../lib/markdown.ts'
import { openChat } from '../../lib/chat-bus.ts'
import { splitLeadingH1 } from '../../lib/article-file.ts'
import { cn } from '../../lib/cn.ts'
import { ARTICLES_PATH, articleUrl, folderOf } from '../../lib/help-path.ts'
import { errorMessage } from '../../lib/errors.ts'
import { articleDate } from '../../lib/article-date.ts'
import { DEFAULT_CATEGORY, plainText } from '../../lib/content-core.ts'
import { articleData, fullDescription, pageHead, sectionDescription, type Crumb } from '../../lib/seo.ts'

// A table of contents is worth it from this many sections.
const MIN_OUTLINE = 3

// /articles/<section>, /articles/<section>/<subsection> and /articles/<folders…>/<article>.
export const Route = createFileRoute('/articles/$')({
  loader: async ({ params }) => {
    const page = await getHelpPage({ data: { path: params._splat ?? '' } })
    if (!page) throw notFound()
    // An old or moved article link: send it (and search engines) to where it is now.
    if (page.kind === 'redirect') throw redirect({ to: '/articles/$', params: { _splat: page.path }, statusCode: 301 })
    return page
  },
  head: ({ loaderData: a }) => {
    if (!a) return {}
    const site = { brandName: a.site.brandName, siteUrl: a.site.url }
    const path = articleUrl(a.path)
    const trail: Crumb[] = [
      { name: 'Home', path: '/' },
      { name: 'Articles', path: ARTICLES_PATH },
    ]
    if (a.kind === 'section') {
      if (a.parent) trail.push({ name: a.parent.title, path: articleUrl(a.parent.path) })
      // The section's own description, from the Knowledge page, or what's in it.
      const titles = a.sections.flatMap((s) => [...s.articles, ...s.subsections.flatMap((sub) => sub.articles)]).map((x) => x.title)
      return pageHead({
        ...site,
        path,
        title: a.title,
        description: sectionDescription(a.title, titles, a.description),
        keywords: [a.title, a.parent?.title, site.brandName, 'help articles'],
        breadcrumbs: trail,
      })
    }
    // An article's sections, when it's in a folder.
    const section = folderOf(a.path, 1)
    const subsection = folderOf(a.path, 2)
    if (section) trail.push({ name: a.category, path: articleUrl(section) })
    if (subsection && a.subcategory) trail.push({ name: a.subcategory, path: articleUrl(subsection) })
    const inSection = a.category !== DEFAULT_CATEGORY ? a.category : undefined
    // Its summary, followed by its opening text (past a # Title that repeats
    // the title) when the summary alone is short.
    const description = fullDescription(a.description, a.body.replace(/^\s*# .*\n/, ''))
    return pageHead({
      ...site,
      path,
      title: a.title,
      description,
      type: 'article',
      modifiedAt: a.modifiedAt,
      section: inSection,
      keywords: [a.title, inSection, a.subcategory, site.brandName],
      breadcrumbs: trail,
      structured: site.siteUrl ? [articleData(site.siteUrl, { ...a, description, path, brandName: site.brandName, section: inSection })] : [],
    })
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

// A section's (or subsection's) own page: its articles, grouped as on /articles.
function SectionPage({ section }: { section: SectionData }) {
  return (
    <div className="mx-auto max-w-[44rem] px-4 pt-10 pb-24 sm:px-6">
      <Breadcrumbs trail={section.parent ? [{ label: section.parent.title, to: { folder: section.parent.path } }] : []} current={section.title} />
      {section.icon && <CollectionIcon icon={section.icon} size={30} className="mt-6 text-primary" />}
      <h1 className={cn('text-3xl font-semibold tracking-tight', section.icon ? 'mt-4' : 'mt-3')}>{section.title}</h1>
      {section.description && <p className="mt-2 text-muted-foreground">{section.description}</p>}
      <p className="mt-2 mb-8 text-sm text-muted-foreground">
        {section.count} {section.count === 1 ? 'article' : 'articles'}
      </p>
      <HelpSections sections={section.sections} titled={false} current={section.path} />
    </div>
  )
}

function ArticlePage({ article }: { article: ArticleData }) {
  const { chatEnabled } = getRouteApi('__root__').useLoaderData()
  const outline = useMemo(() => articleOutline(article.body), [article.body])
  const withToc = outline.length >= MIN_OUTLINE
  const sectionPath = folderOf(article.path, 1)
  const subsectionPath = folderOf(article.path, 2)
  const updated = articleDate(article.modifiedAt, 'long')
  const { heading, rest } = useMemo(() => splitLeadingH1(article.body), [article.body])
  // A heading's Markdown (**bold**, links) shown as its plain words.
  const title = heading ? plainText(heading) : article.title

  return (
    <div
      className={cn(
        'mx-auto px-4 pt-10 pb-24 sm:px-6',
        withToc ? 'max-w-5xl lg:grid lg:grid-cols-[minmax(0,44rem)_13rem] lg:justify-between lg:gap-12' : 'max-w-[44rem]',
      )}
    >
      <div className="min-w-0">
        <Breadcrumbs
          current={title}
          trail={[
            ...(article.category !== DEFAULT_CATEGORY
              ? [{ label: article.category, to: sectionPath ? { folder: sectionPath } : { hash: `cat-${headingSlug(article.category)}` } }]
              : []),
            ...(article.subcategory && subsectionPath ? [{ label: article.subcategory, to: { folder: subsectionPath } }] : []),
          ]}
        />
        {withToc && (
          <details className="mt-6 rounded-xl border border-border bg-card px-4 py-3 lg:hidden">
            <summary className="cursor-pointer text-sm font-medium">On this page</summary>
            <Outline entries={outline} className="mt-3" />
          </details>
        )}

        <article className="prose prose-article mt-8">
          {/* The article's own "# Title" when it has one; articles written in
              the editor keep their title in front matter instead. */}
          <h1 id={headingSlug(title)}>{title}</h1>
          <div className="-mt-1 mb-8 font-sans text-xs text-muted-foreground">
            Updated <time dateTime={article.modifiedAt}>{updated}</time>
          </div>
          <Markdown source={rest} className="prose-article" />
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

        {/* Not while the chat is paused from Settings. */}
        {chatEnabled && (
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
        )}
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

// The article's sections, along a thin line. `tracked` marks the one being
// read: its text in the foreground color, and a darker piece of the line
// beside it that slides from section to section as you scroll.
function Outline({ entries, tracked, className }: { entries: OutlineEntry[]; tracked?: boolean; className?: string }) {
  const [active, setActive] = useActiveSection(tracked ? entries.map((e) => e.id) : [])
  const list = useRef<HTMLUListElement>(null)
  const [marker, setMarker] = useState<{ top: number; height: number } | null>(null)

  // Measured before paint, and again when the column's width rewraps the titles.
  useLayoutEffect(() => {
    const place = () => {
      const link = active ? list.current?.querySelector<HTMLElement>(`a[href="#${CSS.escape(active)}"]`) : null
      setMarker(link ? { top: link.offsetTop, height: link.offsetHeight } : null)
    }
    place()
    if (!list.current) return
    const observer = new ResizeObserver(place)
    observer.observe(list.current)
    return () => observer.disconnect()
  }, [active])

  return (
    <ul ref={list} className={cn('relative grid gap-0.5 border-l border-border text-sm', className)}>
      {tracked && (
        <span
          aria-hidden="true"
          data-motion=""
          className={cn(
            'pointer-events-none absolute -left-px w-0.5 rounded-full bg-foreground transition-[transform,height,opacity] duration-300 ease-out motion-reduce:transition-none',
            marker ? 'opacity-100' : 'opacity-0',
          )}
          style={{ top: 0, height: marker?.height ?? 0, transform: `translateY(${marker?.top ?? 0}px)` }}
        />
      )}
      {entries.map((e) => (
        <li key={e.id}>
          <a
            href={`#${e.id}`}
            aria-current={active === e.id ? 'location' : undefined}
            // Marked at once, even when the page is too short to scroll to it.
            onClick={() => tracked && setActive(e.id)}
            data-motion=""
            className={cn(
              'block py-1 leading-snug transition-colors duration-200 motion-reduce:transition-none hover:text-foreground',
              e.level === 3 ? 'pl-6' : 'pl-3.5',
              active === e.id ? 'font-medium text-foreground' : 'text-muted-foreground',
            )}
          >
            {e.text}
          </a>
        </li>
      ))}
    </ul>
  )
}

// The section heading nearest the top of the screen; at the very bottom of
// the page, the last heading on screen (the last sections may never reach the top).
function useActiveSection(ids: string[]): [string | null, (id: string) => void] {
  const [active, setActive] = useState<string | null>(null)
  const key = ids.join(' ')
  useEffect(() => {
    if (!ids.length) return
    const visible = new Map<string, number>()
    const atBottom = () => {
      if (window.innerHeight + window.scrollY < document.documentElement.scrollHeight - 2) return
      const onScreen = ids.filter((id) => {
        const top = document.getElementById(id)?.getBoundingClientRect().top
        return top !== undefined && top < window.innerHeight
      })
      if (onScreen.length && window.scrollY > 0) setActive(onScreen.at(-1)!)
    }
    window.addEventListener('scroll', atBottom, { passive: true })
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
    return () => {
      observer.disconnect()
      window.removeEventListener('scroll', atBottom)
    }
    // `key` stands in for `ids`, which is a new array each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return [active, setActive]
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
