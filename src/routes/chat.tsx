import { createFileRoute, getRouteApi, Link } from '@tanstack/react-router'
import { ChatWidget } from '../components/ChatWidget.tsx'
import { HelpBot } from '../components/HelpBot.tsx'
import { buttonClass } from '../components/ui.tsx'
import { pageHead, siteFrom } from '../lib/seo.ts'
import { cn } from '../lib/cn.ts'

const root = getRouteApi('__root__')

// The chat, full page: opened with the expand button in the floating chat,
// and the same conversation carries on. The help center's header and footer
// stay around it. Not for search engines: it's a conversation, not content.
export const Route = createFileRoute('/chat')({
  head: ({ matches }) => {
    const site = siteFrom(matches)
    return pageHead({
      ...site,
      path: '/chat',
      title: 'Chat',
      description: `Ask ${site.brandName} a question. Answers come from our help articles, and our team can join the chat.`,
      noindex: true,
    })
  },
  headers: () => ({ 'X-Robots-Tag': 'noindex, nofollow' }),
  component: ChatPage,
})

function ChatPage() {
  const { repoUrl, brandName, chatEnabled } = root.useLoaderData()
  // Paused from Settings: point to the articles instead of an empty page.
  if (!chatEnabled) {
    return (
      <div className="mx-auto max-w-sm px-4 py-24 text-center">
        <HelpBot body="figure" mood="sleepy" size={72} className="mx-auto" />
        <p className="mt-4 font-serif text-2xl">Chat is paused right now</p>
        <p className="mt-2 text-sm text-muted-foreground">Our articles may already have your answer.</p>
        <Link to="/articles" className={cn(buttonClass('outline'), 'mt-6')}>
          Browse articles
        </Link>
      </div>
    )
  }
  return (
    <div className="sm:px-6">
      <ChatWidget repoUrl={repoUrl} brandName={brandName} page />
    </div>
  )
}
