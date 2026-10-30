import { createFileRoute, redirect } from '@tanstack/react-router'

// /help (and a search, /help?q=…) moved to /articles. See ./$.tsx.
export const Route = createFileRoute('/help/')({
  validateSearch: (search: Record<string, unknown>): { q?: string } => (typeof search.q === 'string' && search.q ? { q: search.q } : {}),
  beforeLoad: ({ search }) => {
    throw redirect({ to: '/articles', search, statusCode: 301 })
  },
})
