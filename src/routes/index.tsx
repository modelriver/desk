import { useState } from 'react'
import { createFileRoute, getRouteApi, Link } from '@tanstack/react-router'
import { getHome } from '../functions/help.ts'
import { ArrowUpIcon, ChevronRightIcon } from '../components/icons.tsx'
import { CollectionIcon } from '../components/CollectionIcon.tsx'
import { Button, buttonClass } from '../components/ui.tsx'
import { cn } from '../lib/cn.ts'
import { ArticleList } from '../components/ArticleList.tsx'
import { openChat } from '../lib/chat-bus.ts'
import { pageHead, siteFrom, websiteData } from '../lib/seo.ts'
import { HOME_DEFAULTS } from '../lib/branding.ts'

export const Route = createFileRoute('/')({
  loader: () => getHome(),
  head: ({ matches }) => {
    const site = siteFrom(matches)
    return pageHead({
      ...site,
      path: '/',
      home: true,
      title: site.homeTitle ?? site.brandName,
      description:
        site.description ??
        `Guides and answers from ${site.brandName}. Search the help articles by topic, or ask the assistant and reach our team when you need a person.`,
      keywords: [site.brandName, 'help center', 'support', 'guides', 'FAQ'],
      structured: site.siteUrl ? [websiteData(site.siteUrl, site.brandName)] : [],
    })
  },
  component: Home,
})

const root = getRouteApi('__root__')

function Home() {
  const { articles, sections } = Route.useLoaderData()
  // Chat paused from Settings: the hero points to the articles instead.
  const { chatEnabled, teamCanJoin, ticketsOpen, home } = root.useLoaderData()
  return (
    <div className="mx-auto max-w-3xl px-4 sm:px-6">
      <section className="pt-16 pb-12 sm:pt-24">
        {/* Heading, line and example from Settings → Appearance, else the defaults. */}
        <h1 className="font-serif text-4xl leading-[1.1] tracking-tight sm:text-5xl">{home.heading ?? HOME_DEFAULTS.heading}</h1>
        {chatEnabled ? (
          <>
            <p className="mt-4 max-w-xl text-muted-foreground">{home.intro ?? (teamCanJoin ? HOME_DEFAULTS.intro : ticketsOpen ? HOME_DEFAULTS.introWithoutTeam : HOME_DEFAULTS.introAnswersOnly)}</p>
            <AskBox example={home.example ?? HOME_DEFAULTS.example} />
          </>
        ) : (
          <>
            <p className="mt-4 max-w-xl text-muted-foreground">Find answers in our guides below, or search all of them.</p>
            <Link to="/articles" className={cn(buttonClass('default'), 'mt-6')}>
              Browse all articles
            </Link>
          </>
        )}
      </section>

      {sections.length > 0 && (
        <section className="pb-12" aria-labelledby="topics">
          <h2 id="topics" className="mb-3 text-sm font-medium text-muted-foreground">
            Browse by topic
          </h2>
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {sections.map((s) => (
              <li key={s.path} className="min-w-0">
                <Link
                  to="/articles/$"
                  params={{ _splat: s.path }}
                  className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 hover:border-foreground/25 hover:bg-muted/40"
                >
                  <CollectionIcon icon={s.icon} size={18} className="shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate font-medium">{s.title}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {s.count} {s.count === 1 ? 'article' : 'articles'}
                  </span>
                  <ChevronRightIcon size={16} className="shrink-0 text-muted-foreground" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="pb-24">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-sm font-medium text-muted-foreground">Guides</h2>
          {articles.length > 8 && (
            <Link to="/articles" className="text-sm text-primary hover:underline">
              All {articles.length} articles
            </Link>
          )}
        </div>
        <ArticleList articles={articles.slice(0, 8)} />
      </section>
    </div>
  )
}

// The hero: a composer that opens the chat with the question already sent.
function AskBox({ example }: { example: string }) {
  const [text, setText] = useState('')
  const submit = () => {
    if (!text.trim()) return
    openChat(text)
    setText('')
  }
  return (
    <form
      className="mt-8 rounded-2xl border border-input bg-card p-2 focus-within:border-ring"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <label htmlFor="ask" className="sr-only">
        Your question
      </label>
      <textarea
        id="ask"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            submit()
          }
        }}
        rows={2}
        maxLength={4000}
        placeholder={example}
        className="block w-full resize-none bg-transparent px-3 pt-2 text-base outline-none placeholder:text-muted-foreground"
      />
      <div className="flex items-center justify-between gap-3 pt-1 pl-3">
        <span className="text-xs text-muted-foreground max-sm:hidden">Press Enter to ask</span>
        <Button type="submit" size="sm" className="ml-auto rounded-lg" disabled={!text.trim()}>
          Ask
          <ArrowUpIcon size={14} />
        </Button>
      </div>
    </form>
  )
}
