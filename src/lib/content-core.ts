import { folderOf, helpPath } from './help-path.ts'

// Pure helpers for the data folder: front matter, chunking and BM25 search.
// No I/O here so it can be unit tested directly.

export type Visibility = 'public' | 'private'

export interface Doc {
  // The file's name: the article's id (unique across the public tree), used
  // in citations and votes. Old /articles/<slug> links redirect by it.
  slug: string
  // Where it lives on the help center, after /articles/: its folders, then its
  // slug ("billing/invoices/refunds").
  path: string
  visibility: Visibility
  title: string
  description: string
  // From front matter: `category: Billing` groups articles in the help
  // center; `order: 10` sorts them (lower first). Defaults keep old files working.
  category: string
  // The subfolder an article sits in, under its section's folder.
  subcategory: string | null
  order: number
  body: string
  // Path inside public/ or private/, e.g. "billing/invoices.md".
  file: string
}

export const DEFAULT_CATEGORY = 'General'

export { folderOf, helpPath }
export const DEFAULT_ORDER = 1000

export interface Chunk {
  slug: string
  path: string
  visibility: Visibility
  title: string
  heading: string
  text: string
}

export { parseFrontMatter } from './front-matter.ts'
import { parseFrontMatter } from './front-matter.ts'

export function slugFromFilename(filename: string): string {
  return filename
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

export function toDoc(filename: string, source: string, visibility: Visibility): Doc {
  const { data, body } = parseFrontMatter(source)
  const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim()
  const slug = slugFromFilename(filename.slice(filename.lastIndexOf('/') + 1))
  const order = Number.parseInt(data.order ?? '', 10)
  return {
    slug,
    path: helpPath(filename, slug),
    visibility,
    title: data.title || heading || slug,
    description: data.description || '',
    category: (data.category || DEFAULT_CATEGORY).slice(0, 60),
    subcategory: null,
    order: Number.isFinite(order) ? order : DEFAULT_ORDER,
    body,
    file: filename,
  }
}

export interface ArticleSummary {
  slug: string
  path: string
  title: string
  description: string
  category: string
  subcategory: string | null
  order: number
}

// Articles in reading order: by `order`, then title.
export function sortArticles<T extends ArticleSummary>(articles: T[]): T[] {
  return [...articles].sort((a, b) => a.order - b.order || a.title.localeCompare(b.title))
}

export interface Section<T> {
  category: string
  // The section's folder (its page is /articles/<path>), when it has one.
  path: string | null
  // Articles directly in the section, then its subsections in order.
  articles: T[]
  subsections: Array<{ name: string; path: string | null; articles: T[] }>
}

// The help center's sections. A section (and a subsection) comes where its
// first article does, so arranging articles arranges sections; "General" goes
// last unless placed.
export function groupByCategory<T extends ArticleSummary>(articles: T[]): Array<Section<T>> {
  const groups = new Map<string, T[]>()
  for (const a of sortArticles(articles)) groups.set(a.category, [...(groups.get(a.category) ?? []), a])
  const rank = (category: string, items: T[]) =>
    category === DEFAULT_CATEGORY && items.every((a) => a.order === DEFAULT_ORDER) ? Infinity : items[0]!.order
  return [...groups.entries()]
    .sort(([ca, a], [cb, b]) => rank(ca, a) - rank(cb, b) || ca.localeCompare(cb))
    .map(([category, items]) => {
      const subs = new Map<string, T[]>()
      for (const a of items) if (a.subcategory) subs.set(a.subcategory, [...(subs.get(a.subcategory) ?? []), a])
      return {
        category,
        // The section's own page, when it's a folder.
        path: folderOf(items[0]!.path, 1),
        articles: items.filter((a) => !a.subcategory),
        subsections: [...subs.entries()].map(([name, list]) => ({ name, path: folderOf(list[0]!.path, 2), articles: list })),
      }
    })
}

// A public folder's own details, from its `.desk.json`.
export interface FolderDetails {
  description: string
  icon: string | null
}

export interface Collection<T> extends Section<T> {
  description: string
  icon: string | null
  // Published articles in it, its subsections' included.
  count: number
  subsections: Array<Section<T>['subsections'][number] & { description: string }>
}

// Sections with their folders' descriptions and icons, for the help center's
// cards and section pages. A section without a folder (top-level articles) has neither.
export function withFolderDetails<T>(sections: Array<Section<T>>, folders: ReadonlyMap<string, FolderDetails>): Array<Collection<T>> {
  const detailsOf = (path: string | null) => (path ? folders.get(path) : undefined)
  return sections.map((s) => ({
    ...s,
    description: detailsOf(s.path)?.description ?? '',
    icon: detailsOf(s.path)?.icon ?? null,
    count: s.articles.length + s.subsections.reduce((n, sub) => n + sub.articles.length, 0),
    subsections: s.subsections.map((sub) => ({ ...sub, description: detailsOf(sub.path)?.description ?? '' })),
  }))
}

const MAX_CHUNK_CHARS = 1200

// Split a document into heading-sized pieces, then cap each piece's length on
// paragraph boundaries so one chunk never swamps the prompt.
export function chunkDoc(doc: Doc): Chunk[] {
  const chunks: Chunk[] = []
  let heading = doc.title
  let buffer: string[] = []

  const flush = () => {
    const text = buffer.join('\n').trim()
    buffer = []
    if (!text) return
    let current = ''
    for (const para of text.split(/\n{2,}/)) {
      if (current && current.length + para.length > MAX_CHUNK_CHARS) {
        chunks.push(makeChunk(doc, heading, current))
        current = ''
      }
      current = current ? `${current}\n\n${para}` : para
    }
    if (current) chunks.push(makeChunk(doc, heading, current))
  }

  for (const line of doc.body.split(/\r?\n/)) {
    const h = /^#{1,3}\s+(.+)$/.exec(line)
    if (h) {
      flush()
      heading = h[1]!.trim()
      continue
    }
    buffer.push(line)
  }
  flush()
  return chunks
}

function makeChunk(doc: Doc, heading: string, text: string): Chunk {
  return { slug: doc.slug, path: doc.path, visibility: doc.visibility, title: doc.title, heading, text: text.slice(0, MAX_CHUNK_CHARS * 2) }
}

const STOPWORDS = new Set(
  'a an and are as at be but by can do does for from how i if in is it my of on or so that the this to was we what when where which who why will with you your'.split(' '),
)

// Words for search and retrieval: lower case, no filler words, and a light
// plural fold ("invoices" finds "invoice") so wording differences matter less.
export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map(singular)
}

function singular(word: string): string {
  if (word.length <= 3 || !word.endsWith('s') || /(ss|us|is)$/.test(word)) return word
  return word.endsWith('ies') && word.length > 4 ? `${word.slice(0, -3)}y` : word.slice(0, -1)
}

export interface SearchIndex {
  chunks: Chunk[]
  search(query: string, limit?: number): Chunk[]
  scored(query: string, limit?: number): Array<{ chunk: Chunk; score: number }>
}

// Plain BM25 over chunk text + heading + title. Good enough for a few hundred
// support articles; swap for embeddings if the data folder grows large.
// `scored` returns matches with their scores; `search` just the chunks.
export function buildIndex(chunks: Chunk[]): SearchIndex {
  const k1 = 1.2
  const b = 0.75
  const docs = chunks.map((c) => tokenize(`${c.title} ${c.heading} ${c.text}`))
  const avgLen = docs.reduce((sum, d) => sum + d.length, 0) / Math.max(docs.length, 1)
  const df = new Map<string, number>()
  const tfs = docs.map((tokens) => {
    const tf = new Map<string, number>()
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1)
    return tf
  })

  const scored = (query: string, limit = 5) => {
    const terms = [...new Set(tokenize(query))]
    if (!terms.length) return []
    const hits: Array<{ score: number; i: number }> = []
    tfs.forEach((tf, i) => {
      let score = 0
      const len = docs[i]!.length
      for (const term of terms) {
        const f = tf.get(term)
        if (!f) continue
        const n = df.get(term)!
        const idf = Math.log(1 + (chunks.length - n + 0.5) / (n + 0.5))
        score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * len) / avgLen)))
      }
      if (score > 0) hits.push({ score, i })
    })
    return hits
      .sort((x, y) => y.score - x.score)
      .slice(0, limit)
      .map(({ i, score }) => ({ chunk: chunks[i]!, score }))
  }
  return { chunks, scored, search: (query, limit = 5) => scored(query, limit).map((s) => s.chunk) }
}

// --- Help-center search (public articles only) ---

export interface SearchHit {
  slug: string
  path: string
  title: string
  category: string
  // The best-matching section, and a short plain-text extract around the first match.
  heading: string | null
  snippet: string
  // When the article was last updated (added by the server, which knows it).
  modifiedAt?: string
}

// Markdown to plain text, enough for a one-line extract.
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    // Dividers (---, ***) and table rules (| --- | :-: |) have no words.
    .replace(/^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, ' ')
    .replace(/^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)+\|?[ \t]*$/gm, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_>#|~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// About `size` characters of `text` around the first query term, on word boundaries.
export function snippetFor(text: string, query: string, size = 180): string {
  const plain = plainText(text)
  const terms = tokenize(query)
  const lower = plain.toLowerCase()
  const at = terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0
  let start = Math.max(0, at - Math.floor(size / 3))
  if (start > 0) start = plain.indexOf(' ', start) + 1 || start
  let end = Math.min(plain.length, start + size)
  if (end < plain.length) end = plain.lastIndexOf(' ', end) > start ? plain.lastIndexOf(' ', end) : end
  return `${start > 0 ? '…' : ''}${plain.slice(start, end).trim()}${end < plain.length ? '…' : ''}`
}

// One hit per article, best section first. `index` must hold public chunks only.
export function searchArticles(index: SearchIndex, docs: Doc[], query: string, limit = 10): SearchHit[] {
  const bySlug = new Map(docs.filter((d) => d.visibility === 'public').map((d) => [d.slug, d]))
  const hits: SearchHit[] = []
  const seen = new Set<string>()
  for (const { chunk } of index.scored(query, limit * 4)) {
    const doc = bySlug.get(chunk.slug)
    if (!doc || seen.has(chunk.slug)) continue
    seen.add(chunk.slug)
    hits.push({
      slug: doc.slug,
      path: doc.path,
      title: doc.title,
      category: doc.category,
      heading: chunk.heading !== doc.title ? chunk.heading : null,
      snippet: snippetFor(chunk.text, query),
    })
    if (hits.length === limit) break
  }
  return hits
}

// Up to `limit` articles to read next: the rest of its section in order, then
// the closest matches elsewhere by title and description.
export function relatedArticles(doc: Doc, docs: Doc[], index: SearchIndex, limit = 3): ArticleSummary[] {
  const pub = docs.filter((d) => d.visibility === 'public' && d.slug !== doc.slug)
  // Its own subsection first, then the rest of its section.
  const sameSection = sortArticles(pub.filter((d) => d.category === doc.category)).sort(
    (a, b) => Number(b.subcategory === doc.subcategory) - Number(a.subcategory === doc.subcategory),
  )
  const bySlug = new Map(pub.map((d) => [d.slug, d]))
  const similar = index
    .scored(`${doc.title} ${doc.description}`, 20)
    .map(({ chunk }) => bySlug.get(chunk.slug))
    .filter((d): d is Doc => !!d)
  const picked: Doc[] = []
  for (const d of [...sameSection, ...similar]) {
    if (!picked.includes(d)) picked.push(d)
    if (picked.length === limit) break
  }
  return picked.map(({ slug, path, title, description, category, subcategory, order }) => ({ slug, path, title, description, category, subcategory, order }))
}

// Normalise an uploaded filename to "<slug><ext>" and reject anything that is
// not an allowed type. The caller still checks the final path stays in DATA_DIR.
export function safeFileName(original: string, allowed: string[]): string {
  const base = original.split(/[\\/]/).pop() ?? ''
  const ext = (/\.[A-Za-z0-9]+$/.exec(base)?.[0] ?? '').toLowerCase()
  if (!allowed.includes(ext)) throw new Error(`Only ${allowed.join(', ')} files are allowed here.`)
  const slug = slugFromFilename(base)
  if (!slug) throw new Error('File name must contain letters or numbers.')
  return `${slug}${ext}`
}

