import { useEffect, useState } from 'react'
import { createFileRoute, getRouteApi } from '@tanstack/react-router'
import { ChatWidget } from '../components/ChatWidget.tsx'

const root = getRouteApi('__root__')

// Full-page chat, meant to be embedded in an <iframe> on another site.
// ?identity=<token> verifies a visitor who is signed in on that site (see
// README, Integrations).
export const Route = createFileRoute('/widget')({
  validateSearch: (search: Record<string, unknown>): { identity?: string } =>
    typeof search.identity === 'string' && search.identity.length <= 1000 ? { identity: search.identity } : {},
  head: () => ({ meta: [{ title: 'Support chat' }, { name: 'robots', content: 'noindex' }] }),
  component: WidgetPage,
})

function WidgetPage() {
  const { repoUrl, brandName, logo } = root.useLoaderData()
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
  return <ChatWidget repoUrl={repoUrl} brandName={brandName} logo={logo} embedded identityToken={token} />
}
