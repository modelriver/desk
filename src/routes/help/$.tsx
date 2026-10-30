import { createFileRoute, redirect } from '@tanstack/react-router'

// The help center lived at /help before it moved to /articles. Old links (in
// search engines, bookmarks, emails and past chats) go to the same page there,
// permanently, so search engines move their listing too.
export const Route = createFileRoute('/help/$')({
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/articles/$', params: { _splat: params._splat ?? '' }, statusCode: 301 })
  },
})
