// sitemap.xml and robots.txt, as plain functions so they can be tested.

import { escapeHtml } from './escape.ts'

export interface SitemapEntry {
  path: string
  modifiedAt?: string
}

// `origin` like https://support.acme.com (no trailing slash).
export function sitemapXml(origin: string, entries: SitemapEntry[]): string {
  const urls = entries
    .map((e) => {
      const lastmod = e.modifiedAt ? `<lastmod>${escapeHtml(e.modifiedAt.slice(0, 10))}</lastmod>` : ''
      return `<url><loc>${escapeHtml(origin + e.path)}</loc>${lastmod}</url>`
    })
    .join('')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>\n`
}

// Search engines get the help center; the team's pages and the chat stay out.
export function robotsTxt(origin: string): string {
  return [
    'User-agent: *',
    'Allow: /',
    'Disallow: /dashboard',
    'Disallow: /login',
    'Disallow: /widget',
    'Disallow: /_serverFn',
    '',
    `Sitemap: ${origin}/sitemap.xml`,
    '',
  ].join('\n')
}

// APP_URL when set, else the address the request came in on.
export function siteOrigin(appUrl: string, requestUrl: string): string {
  return appUrl || new URL(requestUrl).origin
}
