import { getDb } from './db.server.ts'
import { allowAll } from './rate-limit.server.ts'
import { clientIp } from './auth.server.ts'
import { deviceId } from './visitor.server.ts'
import { hashToken } from './password.server.ts'
import { folderDetails, getArticle, listArticles, searchHelp } from './content.server.ts'
import { recordVote, voteOf } from './insights.server.ts'
import { groupByCategory, withFolderDetails } from '../lib/content-core.ts'
import { folderOf, resolveHelpPath } from '../lib/help-path.ts'
import { getSiteConfig } from './site-config.server.ts'
import { siteUrl } from './seo.server.ts'
import { MAX_SEARCH_QUERY } from '../lib/search.ts'

// The help center's data: the article list (or search results), one article
// with what visitors need around it, and votes on articles.


export function helpIndex(query: string) {
  const q = query.trim().slice(0, MAX_SEARCH_QUERY)
  // Search is cheap, but it's open to anyone: keep a lid on it per IP.
  const allowed = q ? allowAll([{ key: `help-search:${clientIp()}`, max: 60, windowMs: 60_000 }]) : true
  const articles = listArticles()
  return {
    // Sections in reading order, with their folders' descriptions and icons
    // for the cards; a single "General" section means no sections at all.
    sections: withFolderDetails(groupByCategory(articles), folderDetails()),
    count: articles.length,
    query: q,
    hits: q && allowed ? searchHelp(q, 20) : null,
    limited: Boolean(q) && !allowed,
  }
}

// The sections (top-level folders) with their icons and article counts, in
// reading order: for the home page and the search window.
export function sectionLinks(articles = listArticles()) {
  return withFolderDetails(groupByCategory(articles), folderDetails())
    .filter((s): s is typeof s & { path: string } => s.path !== null)
    .map(({ category, path, icon, count }) => ({ title: category, path, icon, count }))
}

// The home page: its sections, and articles to start with.
export function homePage() {
  const articles = listArticles()
  return { articles, sections: sectionLinks(articles) }
}

// The search window (⌘K): the best few matches while someone types, or the
// sections to browse before they do. Typing sends a search every pause, so it
// has its own, roomier per-IP limit.
export const QUICK_SEARCH_HITS = 8

export function quickSearch(query: string) {
  const q = query.trim().slice(0, MAX_SEARCH_QUERY)
  if (!q) return { query: q, hits: null, limited: false, sections: sectionLinks() }
  const allowed = allowAll([{ key: `help-quick-search:${clientIp()}`, max: 240, windowMs: 60_000 }])
  return { query: q, hits: allowed ? searchHelp(q, QUICK_SEARCH_HITS) : null, limited: !allowed, sections: null }
}

// A vote is tied to the browser's random device id (hashed per article), never to a person.
function voter(slug: string, create: boolean): string | null {
  const device = deviceId(create)
  return device ? hashToken(`${device}:${slug}`) : null
}

export function articlePage(slug: string) {
  const article = getArticle(slug)
  if (!article) return null
  const me = voter(slug, false)
  return {
    ...article,
    myVote: me ? voteOf(slug, me) : null,
    site: { brandName: getSiteConfig().config.brand.name, url: siteUrl() },
  }
}

// What an /articles/<path> URL shows: a section's page (/articles/billing), an article
// (/articles/billing/refunds), or a redirect to where an article lives now. The
// last part of an article URL is its unique name, so links from before a move
// (or from before folders were in URLs) still find it.
export function helpPage(rawPath: string) {
  const path = rawPath.replace(/^\/+|\/+$/g, '')
  const articles = listArticles()
  const target = resolveHelpPath(path, articles)
  if (!target || target.kind === 'redirect') return target
  if (target.kind === 'article') {
    const article = articlePage(target.slug)
    return article && { kind: 'article' as const, ...article }
  }
  const inside = articles.filter((a) => a.path.startsWith(`${path}/`))
  const first = inside[0]!
  const folders = folderDetails()
  return {
    kind: 'section' as const,
    path,
    title: target.depth === 1 ? first.category : (first.subcategory ?? first.category),
    description: folders.get(path)?.description ?? '',
    icon: folders.get(path)?.icon ?? null,
    parent: target.depth === 2 ? { title: first.category, path: folderOf(first.path, 1)! } : null,
    sections: withFolderDetails(groupByCategory(inside), folders),
    count: inside.length,
    site: { brandName: getSiteConfig().config.brand.name, url: siteUrl() },
  }
}

export function voteOnArticle(slug: string, helpful: boolean) {
  if (!allowAll([{ key: `help-vote:${clientIp()}`, max: 30, windowMs: 10 * 60_000 }])) {
    throw new Error('Too many votes. Please try again later.')
  }
  const exists = getDb().prepare('SELECT 1 FROM articles WHERE slug = ?').get(slug)
  if (!exists) throw new Error('Article not found.')
  recordVote({ slug, voter: voter(slug, true)!, helpful })
  return { helpful }
}
