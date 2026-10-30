import { useEffect, useState } from 'react'
import { createFileRoute, getRouteApi } from '@tanstack/react-router'
import { ChatWidget } from '../components/ChatWidget.tsx'
import { HelpBot } from '../components/HelpBot.tsx'
import { buttonClass } from '../components/ui.tsx'
import { ARTICLES_PATH } from '../lib/help-path.ts'
import { cn } from '../lib/cn.ts'

const root = getRouteApi('__root__')

// Full-page chat, meant to be embedded in an <iframe> on another site.
// ?identity=<token> verifies a visitor who is signed in on that site (see
// README, Integrations).
export const Route = createFileRoute('/widget')({
  validateSearch: (search: Record<string, unknown>): { identity?: string } =>
    typeof search.identity === 'string' && search.identity.length <= 1000 ? { identity: search.identity } : {},
  head: () => ({ meta: [{ title: 'Support chat' }, { name: 'robots', content: 'noindex, nofollow' }] }),
  headers: () => ({ 'X-Robots-Tag': 'noindex, nofollow' }),
  component: WidgetPage,
})

function WidgetPage() {
  const { repoUrl, brandName, logo, chatEnabled } = root.useLoaderData()
  const { identity } = Route.useSearch()
  // Kept in memory and taken out of the address bar, so it isn't in the
  // history or sent on as a referrer when the visitor follows a link.
  const [token] = useState(identity ?? null)
  useEffect(() => {
    if (!identity) return
    const url = new URL(window.location.href)
    url.searchParams.delete('identity')
    window.history.replaceState(window.history.state, '', url)
  }, [identity])
  // Paused from Settings: a short note instead of an empty frame on the other site.
  if (!chatEnabled) {
    return (
      <div className="grid min-h-dvh place-items-center bg-background p-6 text-center">
        <div className="max-w-xs">
          <HelpBot body="figure" mood="sleepy" size={64} className="mx-auto" />
          <p className="mt-4 font-medium">Chat is paused right now</p>
          <p className="mt-1 text-sm text-muted-foreground">Our articles may already have your answer.</p>
          <a href={ARTICLES_PATH} target="_blank" rel="noopener" className={cn(buttonClass('outline', 'sm'), 'mt-4')}>
            Browse articles
          </a>
        </div>
      </div>
    )
  }
  return <ChatWidget repoUrl={repoUrl} brandName={brandName} logo={logo} embedded identityToken={token} />
}
