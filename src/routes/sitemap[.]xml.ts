import { createFileRoute } from '@tanstack/react-router'
import { sitemapResponse } from '../server/seo.server.ts'

// /sitemap.xml: the home page, the help center and every public article.
export const Route = createFileRoute('/sitemap.xml')({
  server: { handlers: { GET: ({ request }) => sitemapResponse(request) } },
})
