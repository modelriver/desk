import { createServerFn } from '@tanstack/react-start'
import { asObject, oneOf, str } from './validate.ts'
import { requireUser } from '../server/auth.server.ts'
import { reloadContent } from '../server/content.server.ts'
import * as tree from '../server/tree.server.ts'
import { parseFrontMatter } from '../lib/front-matter.ts'
import { helpPath, slugFromFilename, type Visibility } from '../lib/content-core.ts'

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
    const text = await data.file.text()
    return changed({ path: tree.writeUpload(data.visibility, data.folder, data.file.name, text), visibility: data.visibility })
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
