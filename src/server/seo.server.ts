import { env } from './env.server.ts'
import { listArticles } from './content.server.ts'
import { robotsTxt, siteOrigin, sitemapXml } from '../lib/seo.ts'

// Without APP_URL the links come from the request's Host header, which a
// client controls, so those responses must not be stored by shared caches.
let warned = false
function cacheControl(): string {
  if (env.appUrl) return 'public, max-age=3600'
  if (!warned) {
    warned = true
    console.warn('[seo] APP_URL is not set; sitemap.xml and robots.txt use the request host and are not cached.')
  }
  return 'no-store'
}

export function sitemapResponse(request: Request): Response {
  const origin = siteOrigin(env.appUrl, request.url)
  const articles = listArticles()
  const latest = articles.map((a) => a.modifiedAt).sort().at(-1)
  const body = sitemapXml(origin, [
    { path: '/', modifiedAt: latest },
    { path: '/help', modifiedAt: latest },
    ...articles.map((a) => ({ path: `/help/${a.path}`, modifiedAt: a.modifiedAt })),
  ])
  return new Response(body, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': cacheControl() },
  })
}

export function robotsResponse(request: Request): Response {
  return new Response(robotsTxt(siteOrigin(env.appUrl, request.url)), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': cacheControl() },
  })
}
