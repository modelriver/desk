// sitemap.xml and robots.txt, as plain functions so they can be tested.

import { escapeHtml } from './escape.ts'
import { plainText } from './content-core.ts'

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

// Every section and subsection page (/articles/billing, /articles/billing/invoices),
// last changed when its newest article was.
export function sectionEntries(articles: ReadonlyArray<{ path: string; modifiedAt: string }>): Array<{ path: string; modifiedAt: string }> {
  const latest = new Map<string, string>()
  for (const a of articles) {
    const parts = a.path.split('/')
    // An article's folders, at most two levels deep.
    for (let depth = 1; depth < parts.length && depth <= 2; depth++) {
      const folder = parts.slice(0, depth).join('/')
      if ((latest.get(folder) ?? '') < a.modifiedAt) latest.set(folder, a.modifiedAt)
    }
  }
  return [...latest].sort(([a], [b]) => a.localeCompare(b)).map(([path, modifiedAt]) => ({ path, modifiedAt }))
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

// --- Page heads ---
// Every public page builds its <head> here, so they all carry the same set:
// title, description, a canonical link, Open Graph and Twitter tags and
// schema.org data. Absolute URLs (canonical, og:url, structured data) need
// APP_URL; without it they're left out rather than guessed from the Host
// header, which a client controls.

export interface Crumb {
  name: string
  path: string
}

export interface PageSeo {
  brandName: string
  // APP_URL, e.g. https://support.acme.com, or null when it isn't set.
  siteUrl: string | null
  // The page's own path, e.g. /articles/billing.
  path: string
  // Without the brand; the home page passes the brand itself.
  title: string
  description?: string
  type?: 'website' | 'article'
  // Search results and the like: kept out of search engines, links still followed.
  noindex?: boolean
  // The trail above this page (Home first), for breadcrumbs in search results.
  breadcrumbs?: Crumb[]
  // Extra schema.org objects (an Article, the WebSite).
  structured?: Array<Record<string, unknown>>
  // Open Graph article details.
  modifiedAt?: string
  section?: string
  // Topics for the keywords tag (most search engines ignore it; some tools still check).
  keywords?: Array<string | null | undefined>
}

// What indexable pages tell crawlers: index it, follow its links, and show
// full snippets and large image previews in results.
export const ROBOTS_INDEX = 'index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1'
export const ROBOTS_NOINDEX = 'noindex, follow'

type Meta = Record<string, string>

// Descriptions for pages without one of their own, so a search result shows
// something about the page rather than the site's generic line.
const DESCRIPTION_CHARS = 160

export function excerpt(markdown: string, max = DESCRIPTION_CHARS): string {
  const text = plainText(markdown)
  if (text.length <= max) return text
  const cut = text.lastIndexOf(' ', max - 1)
  return `${text.slice(0, cut > max / 2 ? cut : max - 1).replace(/[,;:.\s]+$/, '')}…`
}

// Search engines show about 150 to 160 characters; a summary much shorter than
// that wastes the space, so it's followed by the page's own text.
const SHORT_DESCRIPTION = 110

export function fullDescription(summary: string, more: string): string {
  const text = summary.trim()
  if (!text) return excerpt(more)
  if (text.length >= SHORT_DESCRIPTION || !more.trim()) return excerpt(text)
  return excerpt(`${/[.!?…]$/.test(text) ? text : `${text}.`} ${more}`)
}

// /articles: what's there, by section.
export function articlesDescription(brandName: string, sections: string[]): string {
  const list = sections.length ? ` by section: ${sections.slice(0, 6).join(', ')}${sections.length > 6 ? ' and more' : ''}.` : '.'
  return excerpt(`Browse ${brandName} articles${list} Search for answers to common questions, or ask the assistant.`)
}

export function sectionDescription(title: string, articleTitles: string[], description = ''): string {
  const list = articleTitles.length
    ? `Help articles on ${title}: ${articleTitles.slice(0, 4).join(', ')}${articleTitles.length > 4 ? ' and more' : ''}.`
    : `Help articles on ${title}.`
  return fullDescription(description, list)
}

// The brand and APP_URL, from the root route's loader, for a page's head().
export function siteFrom(matches: ReadonlyArray<{ routeId: string; loaderData?: unknown }>) {
  const root = matches.find((m) => m.routeId === '__root__')?.loaderData as { brandName?: string; siteUrl?: string | null } | undefined
  return { brandName: root?.brandName ?? 'Help Center', siteUrl: root?.siteUrl ?? null }
}

export function pageHead(p: PageSeo) {
  const title = p.title === p.brandName ? p.title : `${p.title} | ${p.brandName}`
  const url = p.siteUrl ? p.siteUrl + p.path : null
  const description = p.description?.trim() || undefined
  // Once each, whatever the case, as first written.
  const keywords: string[] = []
  for (const k of p.keywords ?? []) {
    const word = k?.trim()
    if (word && !keywords.some((w) => w.toLowerCase() === word.toLowerCase())) keywords.push(word)
  }
  const meta: Meta[] = [
    { title },
    ...(description ? [{ name: 'description', content: description }] : []),
    ...(keywords.length ? [{ name: 'keywords', content: keywords.join(', ') }] : []),
    { name: 'author', content: p.brandName },
    { name: 'publisher', content: p.brandName },
    { name: 'robots', content: p.noindex ? ROBOTS_NOINDEX : ROBOTS_INDEX },
    { property: 'og:locale', content: 'en_US' },
    { property: 'og:type', content: p.type ?? 'website' },
    { property: 'og:title', content: p.title },
    ...(description ? [{ property: 'og:description', content: description }] : []),
    { property: 'og:site_name', content: p.brandName },
    ...(url ? [{ property: 'og:url', content: url }] : []),
    ...(p.modifiedAt ? [{ property: 'article:modified_time', content: p.modifiedAt }] : []),
    ...(p.section ? [{ property: 'article:section', content: p.section }] : []),
    { name: 'twitter:card', content: 'summary' },
    { name: 'twitter:title', content: p.title },
    ...(description ? [{ name: 'twitter:description', content: description }] : []),
  ]
  // A page that shouldn't be indexed has no canonical: the two would contradict.
  const links = url && !p.noindex ? [{ rel: 'canonical', href: url }] : []
  const structured =
    p.siteUrl && !p.noindex
      ? [...(p.breadcrumbs?.length ? [breadcrumbList(p.siteUrl, [...p.breadcrumbs, { name: p.title, path: p.path }])] : []), ...(p.structured ?? [])]
      : []
  return { meta, links, scripts: structured.map((data) => ({ type: 'application/ld+json', children: jsonLd(data) })) }
}

// JSON inside <script>: "</script>" in an article title can't end the tag early.
export function jsonLd(data: Record<string, unknown>): string {
  return JSON.stringify({ '@context': 'https://schema.org', ...data })
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

export function breadcrumbList(siteUrl: string, trail: Crumb[]) {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c.name, item: siteUrl + c.path })),
  }
}

// The help center as a whole, with its search, for the home page.
export function websiteData(siteUrl: string, brandName: string) {
  return {
    '@type': 'WebSite',
    name: brandName,
    url: `${siteUrl}/`,
    potentialAction: {
      '@type': 'SearchAction',
      target: { '@type': 'EntryPoint', urlTemplate: `${siteUrl}/articles?q={search_term_string}` },
      'query-input': 'required name=search_term_string',
    },
  }
}

export function articleData(siteUrl: string, a: { title: string; description: string; path: string; modifiedAt: string; brandName: string; section?: string }) {
  const publisher = { '@type': 'Organization', name: a.brandName, url: `${siteUrl}/` }
  return {
    '@type': 'Article',
    headline: a.title.slice(0, 110),
    ...(a.description ? { description: a.description } : {}),
    dateModified: a.modifiedAt,
    mainEntityOfPage: { '@type': 'WebPage', '@id': siteUrl + a.path },
    ...(a.section ? { articleSection: a.section } : {}),
    author: publisher,
    publisher,
  }
}
