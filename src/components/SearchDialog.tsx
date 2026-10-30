import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { searchArticlesQuick } from '../functions/help.ts'
import { CollectionIcon } from './CollectionIcon.tsx'
import { HelpBot } from './HelpBot.tsx'
import { Highlight } from './Highlight.tsx'
import { FileIcon, SearchIcon, SpinnerIcon } from './icons.tsx'
import { Button } from './ui.tsx'
import { headingSlug } from '../lib/markdown.ts'
import { openChat } from '../lib/chat-bus.ts'
import { cn } from '../lib/cn.ts'
import { DEFAULT_CATEGORY } from '../lib/content-core.ts'
import { MAX_SEARCH_QUERY } from '../lib/search.ts'
import { articleDate } from '../lib/article-date.ts'

// The search window (the header's search, ⌘K): results as you type, picked
// with the arrow keys and Enter, or the sections to browse before typing.
// On the native <dialog>, so focus, Escape and the backdrop come from the browser.

type Results = Awaited<ReturnType<typeof searchArticlesQuick>>
// One row: where it goes, for the arrow keys and Enter.
type Item = { key: string; path: string; hash?: string }

// Wait for a pause in typing, but a short one.
const DEBOUNCE_MS = 90
// Only show the spinner when a search is slow enough to notice.
const SPINNER_AFTER_MS = 250

export function SearchDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const search = useServerFn(searchArticlesQuick)
  const navigate = useNavigate()
  const { chatEnabled } = getRouteApi('__root__').useLoaderData()
  const id = useId()

  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Results | null>(null)
  const [active, setActive] = useState(0)
  const [slow, setSlow] = useState(false)
  // Answers already seen, so going back over a query (or deleting a letter) is instant.
  const cache = useRef(new Map<string, Results>())
  const latest = useRef('')

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (open && !el.open) {
      el.showModal()
      // Pick up where they left off, ready to type over it.
      input.current?.select()
    }
    if (!open && el.open) el.close()
    if (!open) return
    // The page behind stays put while the window is open.
    const html = document.documentElement
    const before = html.style.overflow
    html.style.overflow = 'hidden'
    return () => {
      html.style.overflow = before
    }
  }, [open])

  // Search as they type. Answers can arrive out of order; only the latest counts.
  useEffect(() => {
    if (!open) return
    const q = query.trim().slice(0, MAX_SEARCH_QUERY)
    latest.current = q
    const cached = cache.current.get(q)
    if (cached) {
      setResults(cached)
      setActive(0)
      setSlow(false)
      return
    }
    const spinner = setTimeout(() => setSlow(true), SPINNER_AFTER_MS)
    const timer = setTimeout(
      () => {
        search({ data: { q } })
          .then((res) => {
            // Too many searches isn't an answer worth keeping.
            if (!res.limited) cache.current.set(q, res)
            if (latest.current !== q) return
            setResults(res)
            setActive(0)
          })
          .catch(() => {
            if (latest.current === q) setResults({ query: q, hits: null, limited: true, sections: null })
          })
          .finally(() => {
            if (latest.current === q) {
              clearTimeout(spinner)
              setSlow(false)
            }
          })
      },
      q ? DEBOUNCE_MS : 0,
    )
    return () => {
      clearTimeout(timer)
      clearTimeout(spinner)
    }
  }, [query, open, search])

  const q = query.trim()
  // What's on screen belongs to an older query until the new answer arrives:
  // keep showing it (no flicker), but don't let Enter pick from it.
  const current = results && results.query === q.slice(0, MAX_SEARCH_QUERY) ? results : null
  const items: Item[] = results?.hits
    ? results.hits.map((h) => ({ key: h.slug, path: h.path, hash: h.heading ? headingSlug(h.heading) : undefined }))
    : (results?.sections ?? []).map((s) => ({ key: s.path, path: s.path }))

  // Keep the chosen row in view as the arrow keys move.
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const go = (item: Item) => {
    onClose()
    void navigate({ to: '/articles/$', params: { _splat: item.path }, hash: item.hash })
  }
  const seeAll = () => {
    onClose()
    void navigate({ to: '/articles', search: q ? { q: q.slice(0, MAX_SEARCH_QUERY) } : {} })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!items.length) return
      const step = e.key === 'ArrowDown' ? 1 : -1
      setActive((i) => (i + step + items.length) % items.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (e.nativeEvent.isComposing) return
      const item = current && items[active]
      if (item) go(item)
      else if (q) seeAll()
    }
  }

  const optionId = (i: number) => `${id}-option-${i}`
  const row = (i: number) =>
    cn(
      'flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left',
      i === active ? 'bg-muted text-foreground' : 'text-foreground/90',
    )

  return (
    <dialog
      ref={ref}
      aria-label="Search articles"
      onClose={onClose}
      // A click on the backdrop lands on the <dialog> itself.
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      className="mx-auto mt-[min(12vh,7rem)] mb-auto flex max-h-[min(36rem,calc(100dvh-2*min(12vh,7rem)))] w-[min(40rem,calc(100vw-2rem))] max-w-none flex-col overflow-hidden rounded-2xl border border-border bg-card p-0 text-foreground backdrop:bg-black/40 not-open:hidden"
    >
      <div className="flex items-center gap-3 border-b border-border px-4">
        {slow ? (
          <SpinnerIcon size={18} className="shrink-0 text-muted-foreground" />
        ) : (
          <SearchIcon size={18} className="shrink-0 text-muted-foreground" />
        )}
        <input
          ref={input}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          maxLength={MAX_SEARCH_QUERY}
          placeholder="Search articles"
          autoComplete="off"
          spellCheck={false}
          role="combobox"
          aria-expanded={items.length > 0}
          aria-controls={`${id}-list`}
          aria-activedescendant={items.length ? optionId(active) : undefined}
          aria-autocomplete="list"
          className="h-14 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
        />
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded border border-border px-1.5 text-[11px] leading-5 text-muted-foreground hover:text-foreground"
        >
          Esc
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
        {results?.limited ? (
          <p className="px-3 py-8 text-center text-sm text-muted-foreground">Too many searches in a short time. Please wait a minute.</p>
        ) : results?.hits && results.hits.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-6 py-8 text-center">
            <HelpBot body="figure" mood="thinking" size={56} />
            <div>
              <p className="font-medium">No articles match “{results.query}”</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {chatEnabled ? 'Try other words, or ask the assistant.' : 'Try other words.'}
              </p>
            </div>
            {chatEnabled && (
              <Button
                variant="outline"
                onClick={() => {
                  onClose()
                  openChat(results.query)
                }}
              >
                <HelpBot size={18} />
                Ask the assistant
              </Button>
            )}
          </div>
        ) : results?.hits ? (
          <ul ref={list} id={`${id}-list`} role="listbox" aria-label="Articles">
            {results.hits.map((hit, i) => (
              <li key={hit.slug} id={optionId(i)} role="option" aria-selected={i === active}>
                <Link
                  to="/articles/$"
                  params={{ _splat: hit.path }}
                  hash={items[i]?.hash}
                  tabIndex={-1}
                  onClick={onClose}
                  onMouseMove={() => i !== active && setActive(i)}
                  className={row(i)}
                >
                  <FileIcon size={16} className="mt-0.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className="min-w-0 truncate text-sm font-medium">
                        <Highlight text={hit.title} query={results.query} />
                        {hit.heading && (
                          <span className="font-normal text-muted-foreground">
                            {' › '}
                            <Highlight text={hit.heading} query={results.query} />
                          </span>
                        )}
                      </span>
                      <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                        {hit.category !== DEFAULT_CATEGORY && hit.category}
                        {hit.category !== DEFAULT_CATEGORY && hit.modifiedAt && ' · '}
                        {hit.modifiedAt && <time dateTime={hit.modifiedAt}>{articleDate(hit.modifiedAt)}</time>}
                      </span>
                    </span>
                    <span className="mt-0.5 line-clamp-2 text-[13px] leading-snug text-muted-foreground">
                      <Highlight text={hit.snippet} query={results.query} />
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : results?.sections?.length ? (
          <>
            <p className="px-3 pt-1 pb-1.5 text-xs font-medium text-muted-foreground">Browse sections</p>
            <ul ref={list} id={`${id}-list`} role="listbox" aria-label="Sections">
              {results.sections.map((section, i) => (
                <li key={section.path} id={optionId(i)} role="option" aria-selected={i === active}>
                  <Link
                    to="/articles/$"
                    params={{ _splat: section.path }}
                    tabIndex={-1}
                    onClick={onClose}
                    onMouseMove={() => i !== active && setActive(i)}
                    className={cn(row(i), 'items-center')}
                  >
                    <CollectionIcon icon={section.icon} size={16} className="shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{section.title}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {section.count} {section.count === 1 ? 'article' : 'articles'}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        ) : results ? (
          <p className="px-3 py-8 text-center text-sm text-muted-foreground">Type to search every article.</p>
        ) : null}
      </div>

      <div className="flex items-center gap-4 border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
        <span className="hidden items-center gap-1.5 sm:flex">
          <Key>↑</Key>
          <Key>↓</Key>
          to choose
        </span>
        <span className="hidden items-center gap-1.5 sm:flex">
          <Key>↵</Key>
          to open
        </span>
        {q && results?.hits && results.hits.length > 0 && (
          <button type="button" onClick={seeAll} className="ml-auto font-medium text-foreground hover:underline">
            See all results
          </button>
        )}
      </div>
    </dialog>
  )
}

function Key({ children }: { children: string }) {
  return <kbd className="grid h-5 min-w-5 place-items-center rounded border border-border px-1 font-sans text-[11px] leading-none">{children}</kbd>
}
