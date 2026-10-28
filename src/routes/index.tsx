import { useState } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { getArticles } from '../functions/help.ts'
import { ArrowUpIcon } from '../components/icons.tsx'
import { Button } from '../components/ui.tsx'
import { ArticleList } from '../components/ArticleList.tsx'
import { openChat } from '../lib/chat-bus.ts'

export const Route = createFileRoute('/')({
  loader: () => getArticles(),
  component: Home,
})

function Home() {
  const articles = Route.useLoaderData()
  return (
    <div className="mx-auto max-w-3xl px-4 sm:px-6">
      <section className="pt-16 pb-12 sm:pt-24">
        <h1 className="font-serif text-4xl leading-[1.1] tracking-tight sm:text-5xl">How can we help?</h1>
        <p className="mt-4 max-w-xl text-muted-foreground">
          Ask in your own words. The answer comes from our guides and links to the articles it used. If you need a person, our
          team can join the chat.
        </p>
        <AskBox />
      </section>

      <section className="pb-24">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-sm font-medium text-muted-foreground">Guides</h2>
          {articles.length > 8 && (
            <Link to="/help" className="text-sm text-primary hover:underline">
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
function AskBox() {
  const [text, setText] = useState('')
  const submit = () => {
    if (!text.trim()) return
    openChat(text)
    setText('')
  }
  return (
    <form
      className="mt-8 rounded-2xl border border-input bg-card p-2 shadow-sm focus-within:border-ring"
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
        placeholder="For example: how do I export my whole workspace?"
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
