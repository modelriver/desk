import fs from 'node:fs'
import path from 'node:path'
import { getDb, now } from './db.server.ts'
import { readTree, rootDir, walkFiles } from './tree.server.ts'
import { isDraft } from '../lib/article-file.ts'
import {
  buildIndex,
  chunkDoc,
  relatedArticles,
  searchArticles,
  sortArticles,
  toDoc,
  type ArticleSummary,
  type Doc,
  type SearchHit,
  type SearchIndex,
  type Visibility,
} from '../lib/content-core.ts'

interface ContentState {
  docs: Doc[]
  // Everything, for the AI's context (private notes included).
  index: SearchIndex
  // Public articles only, for help-center search and related articles, so a
  // private note can never surface there.
  publicIndex: SearchIndex
  modified: Map<string, string>
}

let state: ContentState | undefined

// Every file in the tree, in the team's order. Public articles inside a folder
// take its title as their section (and a subfolder's as their subsection);
// articles at the top level keep their own `category:`. Order follows the tree.
function readDocs(visibility: Visibility, modified: Map<string, string>): Doc[] {
  const docs: Doc[] = []
  let position = 0
  for (const { file, folders } of walkFiles(readTree(visibility))) {
    position += 10
    const text = fs.readFileSync(path.join(rootDir(visibility), file.path), 'utf8')
    // Drafts stay out of the index, so out of the help center, the sitemap,
    // search, citations and everything sent to the AI, until they're published.
    if (isDraft(text, file.path)) continue
    const doc = toDoc(file.path, text, visibility)
    if (!doc.slug) continue
    if (folders[0]) {
      doc.category = folders[0].title
      doc.subcategory = folders[1]?.title ?? null
    }
    doc.order = position
    if (visibility === 'public') modified.set(file.path, file.modifiedAt)
    docs.push(doc)
  }
  return docs
}

// Rescan the data folder, rebuild the search index and re-sync article
// metadata into SQLite. Called at startup and after every upload/delete.
export function reloadContent(): ContentState {
  const modified = new Map<string, string>()
  const docs = [...readDocs('public', modified), ...readDocs('private', modified)]
  const chunks = docs.flatMap(chunkDoc)
  const index = buildIndex(chunks)
  const publicIndex = buildIndex(chunks.filter((c) => c.visibility === 'public'))
  syncArticles(docs.filter((d) => d.visibility === 'public'), modified)
  state = { docs, index, publicIndex, modified }
  return state
}

function content(): ContentState {
  return state ?? reloadContent()
}

function syncArticles(publicDocs: Doc[], modified: Map<string, string>) {
  const db = getDb()
  const upsert = db.prepare(
    `INSERT INTO articles (slug, title, description, file, updated_at, category, subcategory, sort_order, modified_at, path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(slug) DO UPDATE SET title = excluded.title, description = excluded.description,
       file = excluded.file, updated_at = excluded.updated_at, category = excluded.category,
       subcategory = excluded.subcategory, sort_order = excluded.sort_order, modified_at = excluded.modified_at,
       path = excluded.path`,
  )
  db.exec('BEGIN')
  try {
    db.exec('DELETE FROM articles')
    const ts = now()
    for (const d of publicDocs) {
      upsert.run(d.slug, d.title, d.description, d.file, ts, d.category, d.subcategory, d.order, modified.get(d.file) ?? ts, d.path)
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

export interface ArticleMeta extends ArticleSummary {
  modifiedAt: string
}

// Public articles in reading order (category sections are grouped by the page).
export function listArticles(): ArticleMeta[] {
  content()
  const rows = getDb()
    .prepare('SELECT slug, path, title, description, category, subcategory, sort_order AS "order", modified_at AS modifiedAt FROM articles')
    .all() as unknown as ArticleMeta[]
  return sortArticles(rows.map((r) => ({ ...r })))
}

// Slugs resolve only through the articles table, so a URL can never name a
// file path or reach the private folder.
export function getArticle(slug: string): (ArticleMeta & { body: string; related: ArticleSummary[] }) | null {
  const { docs, publicIndex } = content()
  const row = getDb()
    .prepare('SELECT slug, path, title, description, category, subcategory, sort_order AS "order", modified_at AS modifiedAt, file FROM articles WHERE slug = ?')
    .get(slug) as (ArticleMeta & { file: string }) | undefined
  if (!row) return null
  const doc = docs.find((d) => d.visibility === 'public' && d.file === row.file)
  if (!doc) return null
  const { file: _file, ...meta } = row
  return { ...meta, body: doc.body, related: relatedArticles(doc, docs, publicIndex) }
}

// Help-center search: public articles only.
export function searchHelp(query: string, limit = 10): SearchHit[] {
  const { docs, publicIndex } = content()
  return searchArticles(publicIndex, docs, query, limit)
}

export function searchContent(query: string, limit = 5) {
  return content().index.search(query, limit)
}

// Every file, for counts (Settings): what the tree shows.
export function listDataFiles() {
  return (['public', 'private'] as const).flatMap((visibility) =>
    [...walkFiles(readTree(visibility))].map(({ file }) => ({ visibility, name: file.path, size: file.size, updatedAt: file.modifiedAt })),
  )
}
