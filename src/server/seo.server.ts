import { getRequest } from '@tanstack/react-start/server'
import { env } from './env.server.ts'
import { listArticles } from './content.server.ts'
import { robotsTxt, siteOrigin, sitemapXml } from '../lib/seo.ts'
import { ARTICLES_PATH, articleUrl } from '../lib/help-path.ts'
import { sectionEntries } from '../lib/seo.ts'

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

// The site's address for canonical links and structured data: APP_URL, or
// the address this request came in on. Behind a proxy you trust
// (TRUST_PROXY_HOPS), its X-Forwarded-Proto says whether that was https.
// Set APP_URL in production: the Host header is the client's to choose.
export function siteUrl(): string {
  if (env.appUrl) return env.appUrl
  const request = getRequest()
  const url = new URL(request.url)
  const proto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase()
  if (env.trustedProxyHops > 0 && (proto === 'https' || proto === 'http')) url.protocol = `${proto}:`
  return url.origin
}

export function sitemapResponse(request: Request): Response {
  const origin = siteOrigin(env.appUrl, request.url)
  const articles = listArticles()
  const latest = articles.map((a) => a.modifiedAt).sort().at(-1)
  const body = sitemapXml(origin, [
    { path: '/', modifiedAt: latest },
    { path: ARTICLES_PATH, modifiedAt: latest },
    ...sectionEntries(articles).map((s) => ({ path: articleUrl(s.path), modifiedAt: s.modifiedAt })),
    ...articles.map((a) => ({ path: articleUrl(a.path), modifiedAt: a.modifiedAt })),
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
