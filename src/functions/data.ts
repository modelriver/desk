import { createServerFn } from '@tanstack/react-start'
import { asObject, oneOf, str } from './validate.ts'
import { requireUser } from '../server/auth.server.ts'
import { reloadContent } from '../server/content.server.ts'
import * as tree from '../server/tree.server.ts'
import { parseFrontMatter } from '../lib/front-matter.ts'
import { helpPath, slugFromFilename, type Visibility } from '../lib/content-core.ts'
import { BATCH_FILES, MAX_PICKED, MAX_UPLOAD_FILES, planFolderUpload } from '../lib/folder-upload.ts'
import { isDraft } from '../lib/article-file.ts'
import { MAX_FOLDER_DESCRIPTION } from '../lib/collection-icons.ts'

// The Data page and the article editor (admins only): the data folder as a
// tree of folders and files. Every change rebuilds the help center and the
// AI's index at once, so there's nothing to restart.

const VISIBILITIES = ['public', 'private'] as const
const KINDS = ['folder', 'file'] as const

// A path inside public/ or private/ ("" for the top level). Checked again,
// part by part, when it's used (tree.server.ts).
function relPath(o: Record<string, unknown>, key: string): string {
  const value = o[key]
  if (value === undefined || value === '') return ''
  if (typeof value !== 'string' || value.length > 300) throw new Error(`${key} is invalid.`)
  return value
}

function changed<T>(result: T): T {
  reloadContent()
  return result
}

export const getDataTree = createServerFn({ method: 'GET' }).handler(() => {
  requireUser('admin')
  return { public: tree.readTree('public'), private: tree.readTree('private') }
})

export const createDataFolder = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const o = asObject(input)
    return { visibility: oneOf(o, 'visibility', VISIBILITIES), parent: relPath(o, 'parent'), title: str(o, 'title', { max: 60 }) }
  })
  .handler(({ data }) => {
    requireUser('admin')
    return changed({ path: tree.createFolder(data.visibility, data.parent, data.title) })
  })

export const renameDataFolder = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const o = asObject(input)
    return { visibility: oneOf(o, 'visibility', VISIBILITIES), path: relPath(o, 'path'), title: str(o, 'title', { max: 60 }) }
  })
  .handler(({ data }) => {
    requireUser('admin')
    return changed({ path: tree.renameFolder(data.visibility, data.path, data.title) })
  })

// A public folder's card on the help center: its description and icon.
export const setDataFolderDetails = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const o = asObject(input)
    const description = o.description ?? ''
    if (typeof description !== 'string' || description.length > MAX_FOLDER_DESCRIPTION + 50) throw new Error('description is invalid.')
    if (o.icon !== null && typeof o.icon !== 'string') throw new Error('icon is invalid.')
    return { path: relPath(o, 'path'), description, icon: o.icon as string | null }
  })
  .handler(({ data }) => {
    requireUser('admin')
    tree.setFolderDetails(data.path, { description: data.description, icon: data.icon })
    return changed({ path: data.path })
  })

export const deleteDataItem = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const o = asObject(input)
    return { visibility: oneOf(o, 'visibility', VISIBILITIES), path: relPath(o, 'path'), kind: oneOf(o, 'kind', KINDS) }
  })
  .handler(({ data }) => {
    requireUser('admin')
    return changed({ files: tree.deleteItem(data.visibility, data.path, data.kind) })
  })

export const moveDataItem = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const o = asObject(input)
    const from = asObject(o.from)
    const to = asObject(o.to)
    const before = to.before
    if (before !== null && (typeof before !== 'string' || before.length > 120)) throw new Error('before is invalid.')
    return {
      from: { visibility: oneOf(from, 'visibility', VISIBILITIES), path: relPath(from, 'path'), kind: oneOf(from, 'kind', KINDS) },
      to: { visibility: oneOf(to, 'visibility', VISIBILITIES), folder: relPath(to, 'folder'), before: before as string | null },
    }
  })
  .handler(({ data }) => {
    requireUser('admin')
    return changed({ path: tree.moveItem(data.from, data.to) })
  })

export const uploadFile = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    if (!(input instanceof FormData)) throw new Error('Expected a file upload.')
    const visibility = input.get('visibility')
    const folder = input.get('folder') ?? ''
    const file = input.get('file')
    if (visibility !== 'public' && visibility !== 'private') throw new Error('Choose public or private.')
    if (typeof folder !== 'string' || folder.length > 300) throw new Error('Invalid folder.')
    if (!(file instanceof File) || file.size === 0) throw new Error('Choose a file.')
    if (file.size > tree.MAX_FILE_BYTES) throw new Error('Files must be 1 MB or smaller.')
    return { visibility: visibility as Visibility, folder, file }
  })
  .handler(async ({ data }) => {
    requireUser('admin')
    const path = tree.writeUpload(data.visibility, data.folder, data.file.name, await data.file.text())
    // New Markdown uploads are drafts; say so, so the page can offer to publish them.
    const draft = isDraft(tree.readFile(data.visibility, path).text, path)
    return changed({ path, visibility: data.visibility, draft })
  })

// --- Folder uploads (see lib/folder-upload.ts) ---

// Checks a whole folder upload against the current tree without writing
// anything: where each file goes, which folders get made, what's skipped, or
// why it can't be uploaded. The browser then sends the files in batches.
export const checkFolderUpload = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const o = asObject(input)
    if (!Array.isArray(o.entries) || o.entries.length > MAX_PICKED) throw new Error('entries is invalid.')
    const entries = o.entries.map((e: unknown) => {
      const entry = asObject(e)
      if (typeof entry.path !== 'string' || entry.path.length > 1000) throw new Error('entries is invalid.')
      if (typeof entry.size !== 'number' || !Number.isFinite(entry.size) || entry.size < 0) throw new Error('entries is invalid.')
      return { path: entry.path, size: entry.size }
    })
    return { visibility: oneOf(o, 'visibility', VISIBILITIES), folder: relPath(o, 'folder'), entries }
  })
  .handler(({ data }) => {
    requireUser('admin')
    return planFolderUpload({
      visibility: data.visibility,
      target: data.folder,
      entries: data.entries,
      tree: tree.readTree(data.visibility),
      allowed: tree.ALLOWED_EXTENSIONS[data.visibility],
      maxBytes: tree.MAX_FILE_BYTES,
    })
  })

// One batch of a checked folder upload: `path` and `file` entries in pairs,
// plus the new folders' titles. New Markdown files are saved as drafts.
// Rebuilds the help center and the AI's index once per batch, so what's live
// always matches what's on disk.
export const uploadFolderBatch = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    if (!(input instanceof FormData)) throw new Error('Expected a file upload.')
    const visibility = input.get('visibility')
    if (visibility !== 'public' && visibility !== 'private') throw new Error('Choose public or private.')
    const paths = input.getAll('path')
    const files = input.getAll('file')
    if (!files.length || files.length > BATCH_FILES || paths.length !== files.length) throw new Error('Invalid upload.')
    const items = files.map((file, i) => {
      const path = paths[i]
      if (typeof path !== 'string' || path.length > 300) throw new Error('Invalid upload.')
      if (!(file instanceof File) || file.size > tree.MAX_FILE_BYTES) throw new Error('Files must be 1 MB or smaller.')
      return { path, file }
    })
    let titles: Record<string, string> = {}
    try {
      const parsed = JSON.parse(String(input.get('titles') ?? '{}')) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        titles = Object.fromEntries(Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === 'string').slice(0, 1000))
      }
    } catch {
      throw new Error('Invalid upload.')
    }
    return { visibility: visibility as Visibility, items, titles }
  })
  .handler(async ({ data }) => {
    requireUser('admin')
    const files = await Promise.all(data.items.map(async (item) => ({ path: item.path, text: await item.file.text() })))
    return changed({ files: tree.writeUploadBatch(data.visibility, files, data.titles) })
  })

// One file for the dashboard preview. Markdown is split here so the browser
// doesn't need the server's content helpers.
export const readDataFile = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const o = asObject(input)
    return { visibility: oneOf(o, 'visibility', VISIBILITIES), path: relPath(o, 'path') }
  })
  .handler(({ data }) => {
    requireUser('admin')
    const { text, size, modifiedAt } = tree.readFile(data.visibility, data.path)
    const markdown = data.path.endsWith('.md')
    const { data: frontMatter, body } = markdown ? parseFrontMatter(text) : { data: {}, body: text }
    const name = data.path.slice(data.path.lastIndexOf('/') + 1)
    return {
      name,
      path: data.path,
      visibility: data.visibility,
      format: markdown ? ('markdown' as const) : ('text' as const),
      title: frontMatter.title ?? null,
      description: frontMatter.description ?? null,
      body,
      helpPath: markdown && data.visibility === 'public' ? helpPath(data.path, slugFromFilename(name)) : null,
      size,
      updatedAt: modifiedAt,
    }
  })

// --- The article editor ---

// An article to edit, or an empty one for a new article in `folder`.
export const getArticleSource = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    const o = asObject(input)
    return { visibility: oneOf(o, 'visibility', VISIBILITIES), path: relPath(o, 'path'), folder: relPath(o, 'folder') }
  })
  .handler(({ data }) => {
    requireUser('admin')
    return data.path ? tree.readArticle(data.visibility, data.path) : tree.newArticle(data.visibility, data.folder)
  })

const STATUSES = ['published', 'draft'] as const

// Publish a draft, or move a published article back to draft (Unpublish),
// from the Data page, without opening it.
export const setArticleStatus = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const o = asObject(input)
    return { visibility: oneOf(o, 'visibility', VISIBILITIES), path: relPath(o, 'path'), status: oneOf(o, 'status', STATUSES) }
  })
  .handler(({ data }) => {
    requireUser('admin')
    return changed(tree.setArticleStatus(data.visibility, data.path, data.status))
  })

// Publish or Unpublish everything selected on the Data page, in one go: all
// the files are checked before any changes, and the index is rebuilt once.
export const setArticlesStatus = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const o = asObject(input)
    if (!Array.isArray(o.items) || !o.items.length || o.items.length > MAX_UPLOAD_FILES) throw new Error('items is invalid.')
    const items = o.items.map((i: unknown) => {
      const item = asObject(i)
      return { visibility: oneOf(item, 'visibility', VISIBILITIES), path: relPath(item, 'path') }
    })
    return { items, status: oneOf(o, 'status', STATUSES) }
  })
  .handler(({ data }) => {
    requireUser('admin')
    return changed({ changed: tree.setArticleStatuses(data.items, data.status) })
  })

// Saves an article as a draft or published (Publish, Save draft, Unpublish).
// A conflict, when someone else saved it since it was opened, comes back as a
// result rather than an error, so the editor can offer to reload or overwrite.
export const saveArticleSource = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const o = asObject(input)
    const body = o.body
    if (typeof body !== 'string' || body.length > tree.MAX_FILE_BYTES) throw new Error('The article is too long.')
    const description = typeof o.description === 'string' ? o.description.slice(0, 300) : ''
    const base = o.baseModifiedAt
    return {
      visibility: oneOf(o, 'visibility', VISIBILITIES),
      folder: relPath(o, 'folder'),
      path: o.path ? relPath(o, 'path') : null,
      baseModifiedAt: typeof base === 'string' ? base : null,
      fields: { title: str(o, 'title', { max: 150 }), description, body },
      status: oneOf(o, 'status', STATUSES),
    }
  })
  .handler(({ data }) => {
    requireUser('admin')
    try {
      return changed({ ok: true as const, ...tree.saveArticle(data) })
    } catch (err) {
      if (err instanceof tree.SaveConflict) return { ok: false as const, conflict: true as const, message: err.message, theirsAt: err.theirsAt }
      throw err
    }
  })
