import { createFileRoute } from '@tanstack/react-router'
import { robotsResponse } from '../server/seo.server.ts'

// /robots.txt: points search engines at the sitemap and away from the dashboard.
export const Route = createFileRoute('/robots.txt')({
  server: { handlers: { GET: ({ request }) => robotsResponse(request) } },
})
