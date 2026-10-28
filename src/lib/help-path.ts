// Help-center URLs, shared by the server and the browser (no Node imports).

// An article's help-center path from its file: "billing/plans.md" with slug
// "plans" is "billing/plans". Folder names are already URL-safe (lowercase,
// hyphens for spaces).
export function helpPath(file: string, slug: string): string {
  const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : ''
  return dir ? `${dir}/${slug}` : slug
}

// The first `depth` folders of a help-center path, or null when it isn't that deep in folders.
export function folderOf(path: string, depth: number): string | null {
  const parts = path.split('/')
  return parts.length > depth ? parts.slice(0, depth).join('/') : null
}

// What a /help/<path> URL names, given the public articles (slug + path):
// a section or subsection (its folder has articles), an article at its
// current address, or an article that has moved, found by its unique name
// (the last part of the URL). Null when nothing matches.
export type HelpTarget =
  | { kind: 'section'; depth: number }
  | { kind: 'article'; slug: string }
  | { kind: 'redirect'; path: string }

export function resolveHelpPath(rawPath: string, articles: Array<{ slug: string; path: string }>): HelpTarget | null {
  const path = rawPath.replace(/^\/+|\/+$/g, '')
  if (!path) return null
  // An exact article first (the app keeps folder and article names apart, but
  // a data folder edited by hand might not).
  const exact = articles.find((a) => a.path === path)
  if (exact) return { kind: 'article', slug: exact.slug }
  if (articles.some((a) => a.path.startsWith(`${path}/`))) return { kind: 'section', depth: path.split('/').length }
  const slug = path.slice(path.lastIndexOf('/') + 1)
  const article = articles.find((a) => a.slug === slug)
  if (!article) return null
  return article.path === path ? { kind: 'article', slug } : { kind: 'redirect', path: article.path }
}
