import fs from 'node:fs'
import path from 'node:path'
import { env } from './env.server.ts'
import { parseFrontMatter, safeFileName, slugFromFilename, type Visibility } from '../lib/content-core.ts'
import {
  assertCanMove,
  baseName,
  depthOf,
  folderName,
  joinPath,
  MAX_DEPTH,
  META_FILE,
  orderChildren,
  parentOf,
  parseMeta,
  parsePath,
  PathError,
  placeInOrder,
  titleFromName,
  type FolderMeta,
} from '../lib/tree-core.ts'
import {
  articleBodyForEditor,
  canBeDraft,
  isDraft,
  serializeArticle,
  statusOf,
  withStatus,
  type ArticleFields,
  type ArticleStatus,
} from '../lib/article-file.ts'
import { foldersFor } from '../lib/folder-upload.ts'

// Reading and changing the data folder as a tree of folders and files. Every
// path goes through resolve(), which validates each part and refuses symlinks,
// so nothing here can reach outside DATA_DIR/public or DATA_DIR/private.

export const ALLOWED_EXTENSIONS: Record<Visibility, string[]> = {
  public: ['.md'],
  private: ['.md', '.txt'],
}
export const MAX_FILE_BYTES = 1024 * 1024

export interface FileNode {
  kind: 'file'
  name: string
  path: string
  title: string
  description: string
  slug: string
  // An unpublished draft (`status: draft`): kept out of the help center and the AI.
  draft: boolean
  size: number
  modifiedAt: string
}

export interface FolderNode {
  kind: 'folder'
  name: string
  path: string
  title: string
  children: Array<FolderNode | FileNode>
}

export function rootDir(visibility: Visibility): string {
  return path.join(env.dataDir, visibility)
}

function resolve(visibility: Visibility, rel: string, kind: 'folder' | 'file'): string {
  const parts = parsePath(rel, kind)
  const root = rootDir(visibility)
  let at = root
  for (const part of parts) {
    at = path.join(at, part)
    // An existing part must be a real folder or file, never a link out of DATA_DIR.
    const stat = fs.lstatSync(at, { throwIfNoEntry: false })
    if (stat?.isSymbolicLink()) throw new PathError('Links aren’t allowed in the data folder.')
  }
  return at
}

// --- Reading ---

function readMeta(dir: string): FolderMeta {
  const file = path.join(dir, META_FILE)
  return parseMeta(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null)
}

function writeMeta(dir: string, meta: FolderMeta) {
  fs.writeFileSync(path.join(dir, META_FILE), `${JSON.stringify(meta, null, 2)}\n`)
}

function fileNode(visibility: Visibility, rel: string, abs: string): FileNode {
  const stat = fs.statSync(abs)
  const name = baseName(rel)
  let title = name
  let description = ''
  let draft = false
  if (name.endsWith('.md')) {
    const { data, body } = parseFrontMatter(fs.readFileSync(abs, 'utf8'))
    title = data.title || /^#\s+(.+)$/m.exec(body)?.[1]?.trim() || slugFromFilename(name)
    description = data.description ?? ''
    draft = statusOf(data) === 'draft'
  }
  return {
    kind: 'file',
    name,
    path: rel,
    title,
    description,
    slug: visibility === 'public' ? slugFromFilename(name) : '',
    draft,
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
  }
}

// Root files keep their front-matter `order:` until someone arranges the top level.
function legacyOrder(abs: string): number {
  if (!abs.endsWith('.md')) return 1000
  const n = Number.parseInt(parseFrontMatter(fs.readFileSync(abs, 'utf8')).data.order ?? '', 10)
  return Number.isFinite(n) ? n : 1000
}

export function readTree(visibility: Visibility, rel = ''): FolderNode {
  const dir = resolve(visibility, rel, 'folder')
  const meta = readMeta(dir)
  const entries = fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []
  const items = entries
    .filter((e) => !e.name.startsWith('.') && !e.isSymbolicLink())
    .filter((e) =>
      e.isDirectory()
        ? depthOf(rel) < MAX_DEPTH && /^[a-z0-9][a-z0-9-]*$/.test(e.name)
        : e.isFile() && ALLOWED_EXTENSIONS[visibility].includes(path.extname(e.name).toLowerCase()),
    )
  let names = items.map((e) => ({ name: e.name, folder: e.isDirectory() }))
  if (!meta.order && rel === '') {
    // Not arranged yet: folders first, then files by their old `order:` and name.
    names = names.sort(
      (a, b) =>
        Number(b.folder) - Number(a.folder) ||
        (a.folder ? 0 : legacyOrder(path.join(dir, a.name)) - legacyOrder(path.join(dir, b.name))) ||
        a.name.localeCompare(b.name),
    )
  }
  const ordered = meta.order ? orderChildren(names, meta.order) : names.map((n) => n.name)
  const byName = new Map(items.map((e) => [e.name, e]))
  return {
    kind: 'folder',
    name: baseName(rel),
    path: rel,
    title: rel ? (meta.title ?? titleFromName(baseName(rel))) : visibility === 'public' ? 'Public' : 'Private',
    children: ordered.map((name) => {
      const entry = byName.get(name)!
      const childRel = joinPath(rel, name)
      return entry.isDirectory() ? readTree(visibility, childRel) : fileNode(visibility, childRel, path.join(dir, name))
    }),
  }
}

export function* walkFiles(folder: FolderNode, ancestors: FolderNode[] = []): Generator<{ file: FileNode; folders: FolderNode[] }> {
  for (const child of folder.children) {
    if (child.kind === 'file') yield { file: child, folders: ancestors }
    else yield* walkFiles(child, [...ancestors, child])
  }
}

function findFolder(tree: FolderNode, rel: string): FolderNode | null {
  if (tree.path === rel) return tree
  for (const c of tree.children) {
    if (c.kind === 'folder') {
      const hit = findFolder(c, rel)
      if (hit) return hit
    }
  }
  return null
}

function subtreeDepthOf(folder: FolderNode): number {
  const subs = folder.children.filter((c): c is FolderNode => c.kind === 'folder')
  return subs.length ? 1 + Math.max(...subs.map(subtreeDepthOf)) : 0
}

// --- An article's file name is its id (old links find it by name), so public names are unique across all folders ---

function publicSlugTaken(slug: string, except?: string): string | null {
  for (const { file, folders } of walkFiles(readTree('public'))) {
    if (file.slug === slug && file.path !== except) return folders.map((f) => f.title).join(' › ') || 'Public'
  }
  return null
}

// A public folder and an article beside it can't share a name: both would be
// /help/<folder>/<name>. True when `name` is taken in that folder, by a folder
// or an article, or only by one `kind` when given.
function urlTaken(visibility: Visibility, folderRel: string, name: string, kind?: 'folder' | 'file'): boolean {
  if (visibility !== 'public') return false
  return readTree('public', folderRel).children.some((c) => (!kind || c.kind === kind) && (c.kind === 'folder' ? c.name === name : c.slug === name))
}

// A new folder clashes only with an article of its name, and an article only
// with a folder: an article with its own name is the one being replaced.
function assertUrlFree(visibility: Visibility, folderRel: string, name: string, what: 'folder' | 'article') {
  if (urlTaken(visibility, folderRel, name, what === 'folder' ? 'file' : 'folder')) {
    throw new PathError(
      what === 'folder' ? `An article called “${name}” is already there, and they’d share a web address.` : `A folder called “${name}” is already there, and they’d share a web address.`,
    )
  }
}

function assertSlugFree(slug: string, except?: string) {
  const where = publicSlugTaken(slug, except)
  if (where) throw new PathError(`An article named “${slug}” already exists in ${where}. Rename one of them first.`)
}

// --- Changing ---

function updateOrder(visibility: Visibility, folderRel: string, change: (order: string[]) => string[]) {
  const dir = resolve(visibility, folderRel, 'folder')
  const current = readTree(visibility, folderRel).children.map((c) => c.name)
  writeMeta(dir, { ...readMeta(dir), order: change(current) })
}

export function createFolder(visibility: Visibility, parentRel: string, title: string): string {
  const clean = title.trim().slice(0, 60)
  if (!clean) throw new PathError('Give the folder a name.')
  if (depthOf(parentRel) >= MAX_DEPTH) throw new PathError(`Folders can only go ${MAX_DEPTH} levels deep.`)
  const base = folderName(clean) || 'folder'
  const parentDir = resolve(visibility, parentRel, 'folder')
  fs.mkdirSync(parentDir, { recursive: true })
  let name = base
  for (let i = 2; fs.existsSync(path.join(parentDir, name)) || urlTaken(visibility, parentRel, name); i++) name = `${base}-${i}`
  const rel = joinPath(parentRel, name)
  const dir = resolve(visibility, rel, 'folder')
  fs.mkdirSync(dir)
  writeMeta(dir, { title: clean })
  updateOrder(visibility, parentRel, (order) => placeInOrder(order, name, null))
  return rel
}

// Renames a folder: its title, and its name on disk, which is its part of
// help-center URLs ("Plans & pricing" -> /help/plans-pricing/…). Links to the
// old URLs still work: articles are found by their own name. Returns the new path.
export function renameFolder(visibility: Visibility, rel: string, title: string): string {
  const clean = title.trim().slice(0, 60)
  if (!rel) throw new PathError('The top level can’t be renamed.')
  if (!clean) throw new PathError('Give the folder a name.')
  const dir = resolve(visibility, rel, 'folder')
  if (!fs.existsSync(dir)) throw new PathError('That folder no longer exists.')
  writeMeta(dir, { ...readMeta(dir), title: clean })

  const oldName = baseName(rel)
  const base = folderName(clean) || 'folder'
  if (base === oldName) return rel
  const parent = parentOf(rel)
  const parentDir = resolve(visibility, parent, 'folder')
  let name = base
  for (let i = 2; fs.existsSync(path.join(parentDir, name)) || urlTaken(visibility, parent, name); i++) name = `${base}-${i}`
  fs.renameSync(dir, path.join(parentDir, name))
  // Keep its place among its neighbours.
  const meta = readMeta(parentDir)
  if (meta.order) writeMeta(parentDir, { ...meta, order: meta.order.map((n) => (n === oldName ? name : n)) })
  return joinPath(parent, name)
}

// Deletes a file, or a folder with everything in it. Returns how many files went.
export function deleteItem(visibility: Visibility, rel: string, kind: 'folder' | 'file'): number {
  if (kind === 'folder' && !rel) throw new PathError('The top level can’t be deleted.')
  const abs = resolve(visibility, rel, kind)
  if (!fs.existsSync(abs)) throw new PathError('It no longer exists.')
  let files = 1
  if (kind === 'folder') {
    files = [...walkFiles(readTree(visibility, rel))].length
    fs.rmSync(abs, { recursive: true })
  } else {
    fs.unlinkSync(abs)
  }
  updateOrder(visibility, parentOf(rel), (order) => order.filter((n) => n !== baseName(rel)))
  return files
}

// Moves a file or folder into `to.folder` (possibly the other visibility),
// placed before `to.before` (or last). Moving within a folder just reorders it.
export function moveItem(
  from: { visibility: Visibility; path: string; kind: 'folder' | 'file' },
  to: { visibility: Visibility; folder: string; before: string | null },
) {
  const name = baseName(from.path)
  const src = resolve(from.visibility, from.path, from.kind)
  if (!fs.existsSync(src)) throw new PathError('It no longer exists. Refresh the page.')
  const targetDir = resolve(to.visibility, to.folder, 'folder')
  if (!fs.existsSync(targetDir)) throw new PathError('That folder no longer exists. Refresh the page.')

  const sameFolder = from.visibility === to.visibility && parentOf(from.path) === to.folder
  if (!sameFolder) {
    if (from.kind === 'folder') {
      if (from.visibility === to.visibility) assertCanMove(from.path, to.folder)
      const node = readTree(from.visibility, from.path)
      if (depthOf(to.folder) + 1 + subtreeDepthOf(node) > MAX_DEPTH) {
        throw new PathError(`That would put folders more than ${MAX_DEPTH} levels deep.`)
      }
      if (to.visibility === 'public') {
        for (const { file } of walkFiles(node)) {
          if (!file.name.endsWith('.md')) throw new PathError('Text files can only be internal notes. Move them out first.')
          if (from.visibility === 'private') assertSlugFree(slugFromFilename(file.name))
        }
      }
    } else if (to.visibility === 'public') {
      if (!name.endsWith('.md')) throw new PathError('Only Markdown files can be help-center articles.')
      if (from.visibility === 'private') assertSlugFree(slugFromFilename(name))
    }
    if (fs.existsSync(path.join(targetDir, name))) throw new PathError(`There’s already a “${name}” in that folder.`)
    if (from.kind === 'folder') assertUrlFree(to.visibility, to.folder, name, 'folder')
    else if (name.endsWith('.md')) assertUrlFree(to.visibility, to.folder, slugFromFilename(name), 'article')
    fs.renameSync(src, resolve(to.visibility, joinPath(to.folder, name), from.kind))
    updateOrder(from.visibility, parentOf(from.path), (order) => order.filter((n) => n !== name))
  }
  updateOrder(to.visibility, to.folder, (order) => placeInOrder(order, name, to.before))
  return joinPath(to.folder, name)
}

// --- Files ---

export function writeUpload(visibility: Visibility, folderRel: string, originalName: string, text: string): string {
  if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new PathError('Files must be 1 MB or smaller.')
  if (text.includes('\u0000')) throw new PathError('That does not look like a text file.')
  const name = safeFileName(originalName, ALLOWED_EXTENSIONS[visibility])
  const rel = joinPath(folderRel, name)
  const abs = resolve(visibility, rel, 'file')
  if (!fs.existsSync(resolve(visibility, folderRel, 'folder'))) throw new PathError('That folder no longer exists.')
  // Uploading over a file of the same name replaces it, as before; a public
  // name used in another folder would make two articles share a URL.
  if (visibility === 'public') {
    assertSlugFree(slugFromFilename(name), rel)
    assertUrlFree(visibility, folderRel, slugFromFilename(name), 'article')
  }
  const existed = fs.existsSync(abs)
  fs.writeFileSync(abs, text)
  if (!existed) updateOrder(visibility, folderRel, (order) => placeInOrder(order, name, null))
  return rel
}

// One batch of a folder upload (see lib/folder-upload.ts): each file at the
// path the plan gave it, creating the folders it needs with their titles and
// merging into folders that already exist. Everything in the batch is checked
// before anything is written. Returns how many files were written.
export function writeUploadBatch(visibility: Visibility, files: Array<{ path: string; text: string }>, titles: Record<string, string>): number {
  const seen = new Set<string>()
  for (const file of files) {
    const name = baseName(file.path)
    if (Buffer.byteLength(file.text) > MAX_FILE_BYTES) throw new PathError(`${name} is over 1 MB.`)
    if (file.text.includes('\u0000')) throw new PathError(`${name} does not look like a text file.`)
    if (!ALLOWED_EXTENSIONS[visibility].includes(path.extname(name))) throw new PathError(`${name} isn’t a file type allowed here.`)
    resolve(visibility, file.path, 'file')
    if (seen.has(file.path)) throw new PathError(`${file.path} is in the upload twice.`)
    seen.add(file.path)
  }
  const folders = foldersFor([...seen], titles)
  const missing = folders.filter((f) => !fs.existsSync(resolve(visibility, f.path, 'folder')))
  const creating = new Set(missing.map((f) => f.path))

  if (visibility === 'public') {
    const slugs = new Map<string, string>()
    for (const { file } of walkFiles(readTree('public'))) slugs.set(file.slug, file.path)
    const batchSlugs = new Map<string, string>()
    for (const file of files) {
      const slug = slugFromFilename(baseName(file.path))
      const taken = slugs.get(slug)
      if (taken && taken !== file.path) throw new PathError(`An article named “${slug}” already exists at ${taken}. Rename one of them first.`)
      const twin = batchSlugs.get(slug)
      if (twin) throw new PathError(`${twin} and ${file.path} would both be the article “${slug}”.`)
      batchSlugs.set(slug, file.path)
      // An article clashes only with a folder of its name. Looked up directly:
      // reading the whole folder for every file is slow in big folders.
      const asFolder = file.path.slice(0, -3)
      if (creating.has(asFolder) || fs.statSync(path.join(rootDir(visibility), asFolder), { throwIfNoEntry: false })?.isDirectory()) {
        throw new PathError(`${file.path} would share a web address with a folder of the same name.`)
      }
    }
    for (const folder of missing) assertUrlFree(visibility, parentOf(folder.path), baseName(folder.path), 'folder')
  }

  // New names per folder, in order: folders first, then files. Each folder's
  // order is written once for the batch.
  const added = new Map<string, string[]>()
  const add = (rel: string) => added.set(parentOf(rel), [...(added.get(parentOf(rel)) ?? []), baseName(rel)])
  for (const folder of missing) {
    fs.mkdirSync(resolve(visibility, folder.path, 'folder'))
    writeMeta(resolve(visibility, folder.path, 'folder'), { title: folder.title.trim().slice(0, 60) || titleFromName(baseName(folder.path)) })
    add(folder.path)
  }
  for (const file of files) {
    const abs = resolve(visibility, file.path, 'file')
    if (!fs.existsSync(abs)) add(file.path)
    fs.writeFileSync(abs, file.text)
  }
  for (const [parent, names] of added) updateOrder(visibility, parent, (order) => names.reduce((o, name) => placeInOrder(o, name, null), order))
  return files.length
}

export function readFile(visibility: Visibility, rel: string) {
  const abs = resolve(visibility, rel, 'file')
  if (!fs.existsSync(abs)) throw new PathError('That file no longer exists.')
  return { text: fs.readFileSync(abs, 'utf8'), modifiedAt: fs.statSync(abs).mtime.toISOString(), size: fs.statSync(abs).size }
}

// What the editor needs: the fields, and the body without its title heading.
export function readArticle(visibility: Visibility, rel: string) {
  const { text, modifiedAt } = readFile(visibility, rel)
  const folder = parentOf(rel)
  return {
    visibility,
    path: rel as string | null,
    folder,
    format: rel.endsWith('.txt') ? ('text' as const) : ('markdown' as const),
    slug: visibility === 'public' ? slugFromFilename(baseName(rel)) : null,
    location: locationOf(visibility, folder),
    modifiedAt: modifiedAt as string | null,
    status: (isDraft(text, rel) ? 'draft' : 'published') as ArticleStatus,
    ...articleBodyForEditor(text, rel),
  }
}

// The same, empty, for a new article in `folder`.
export function newArticle(visibility: Visibility, folder: string): ReturnType<typeof readArticle> {
  if (!fs.existsSync(resolve(visibility, folder, 'folder'))) throw new PathError('That folder no longer exists.')
  return {
    visibility,
    path: null,
    folder,
    format: 'markdown',
    slug: null,
    location: locationOf(visibility, folder),
    modifiedAt: null,
    // Not saved yet: it becomes a draft or is published on its first save.
    status: 'draft',
    title: '',
    description: '',
    body: '',
  }
}

// Folder titles from the top ("Public", "Getting started", …).
function locationOf(visibility: Visibility, folder: string): string[] {
  const tree = readTree(visibility)
  return [tree, ...(folder ? ancestorsOf(tree, folder) : [])].map((f) => f.title)
}

function ancestorsOf(tree: FolderNode, folderRel: string): FolderNode[] {
  const parts = folderRel.split('/')
  return parts.map((_, i) => findFolder(tree, parts.slice(0, i + 1).join('/'))).filter((f): f is FolderNode => !!f)
}

export class SaveConflict extends Error {
  // When the newer version was saved.
  theirsAt: string
  constructor(message: string, theirsAt: string) {
    super(message)
    this.theirsAt = theirsAt
  }
}

// Saves an existing file, or creates a new article when `path` is null. Refuses
// to overwrite a file that changed since it was opened (`baseModifiedAt`).
export function saveArticle(input: {
  visibility: Visibility
  folder: string
  path: string | null
  baseModifiedAt: string | null
  fields: ArticleFields
  // Draft or published. Left out, an existing file keeps its status and a new one is published.
  status?: ArticleStatus
}): { path: string; modifiedAt: string } {
  let rel = input.path
  let previous: string | null = null
  if (rel) {
    const current = readFile(input.visibility, rel)
    if (input.baseModifiedAt && current.modifiedAt !== input.baseModifiedAt) {
      throw new SaveConflict('This article was changed by someone else since you opened it.', current.modifiedAt)
    }
    previous = current.text
  } else {
    if (!fs.existsSync(resolve(input.visibility, input.folder, 'folder'))) throw new PathError('That folder no longer exists.')
    const base = slugFromFilename(input.fields.title) || 'untitled'
    let slug = base
    for (let i = 2; ; i++) {
      const candidate = joinPath(input.folder, `${slug}.md`)
      const taken =
        fs.existsSync(resolve(input.visibility, candidate, 'file')) || (input.visibility === 'public' && (publicSlugTaken(slug) || urlTaken('public', input.folder, slug)))
      if (!taken) break
      slug = `${base}-${i}`
    }
    rel = joinPath(input.folder, `${slug}.md`)
  }
  if (input.status === 'draft' && !canBeDraft(rel)) throw new PathError(NOT_DRAFTABLE)
  const text = rel.endsWith('.txt') ? input.fields.body : serializeArticle(input.fields, previous, input.status)
  if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new PathError('Articles must be 1 MB or smaller.')
  const abs = resolve(input.visibility, rel, 'file')
  fs.writeFileSync(abs, text)
  if (!input.path) updateOrder(input.visibility, input.folder, (order) => placeInOrder(order, baseName(rel), null))
  return { path: rel, modifiedAt: fs.statSync(abs).mtime.toISOString() }
}

const NOT_DRAFTABLE = 'Plain-text notes can’t be drafts. Use a Markdown (.md) note for that.'

// Publish a draft, or move a published file back to draft (Unpublish), without
// touching anything else in it.
export function setArticleStatus(visibility: Visibility, rel: string, status: ArticleStatus): { path: string; modifiedAt: string } {
  if (!canBeDraft(rel)) throw new PathError(NOT_DRAFTABLE)
  const { text } = readFile(visibility, rel)
  const next = withStatus(text, status)
  const abs = resolve(visibility, rel, 'file')
  if (next !== text) fs.writeFileSync(abs, next)
  return { path: rel, modifiedAt: fs.statSync(abs).mtime.toISOString() }
}
