// Uploading whole folders from the Data page. Pure helpers, no I/O: the server
// plans the upload against the current tree before anything is written, and
// the browser packs the files into batches that fit under the 2 MB request
// limit of the proxies Desk ships with (Caddy and nginx).
//
// A dropped folder keeps its shape: "Getting Started/Quick start.md" dropped on
// Public becomes the section getting-started (titled "Getting Started") with
// the article quick-start.md. Hidden files, other file types and empty files
// are skipped and reported; anything that would break the help center (too
// deep, too big, two articles with one name) refuses the whole upload.

import { safeFileName, slugFromFilename, type Visibility } from './content-core.ts'
import { baseName, depthOf, folderName, joinPath, MAX_DEPTH, parentOf, parsePath, titleFromName } from './tree-core.ts'

export const MAX_UPLOAD_FILES = 1000
// Files read from a picked or dropped folder before giving up, skipped ones included.
export const MAX_PICKED = 5000
// Per request. Desk's Caddy and nginx configs refuse bodies over 2 MB; this
// leaves room for the form's own overhead.
export const BATCH_BYTES = 1.5 * 1024 * 1024
export const BATCH_FILES = 100

export interface UploadEntry {
  // Where the file sits in what was dropped or picked: "Billing/Plans.md".
  path: string
  size: number
}

// Just enough of the Data page tree to plan against.
export interface PlanTree {
  kind: 'folder'
  name: string
  path: string
  children: Array<PlanTree | { kind: 'file'; name: string; path: string }>
}

export interface UploadPlan {
  // Folders to create, parents first. Folders that already exist aren't listed.
  folders: Array<{ path: string; title: string }>
  // Every file to write, by path. `replaces` when a file of that name is already there.
  files: Array<{ source: string; path: string; replaces: boolean }>
  skipped: Array<{ source: string; reason: 'hidden' | 'type' | 'empty' }>
}

export type PlanResult = { ok: true; plan: UploadPlan } | { ok: false; problems: string[] }

function* walk(folder: PlanTree): Generator<PlanTree | { kind: 'file'; name: string; path: string }> {
  for (const child of folder.children) {
    yield child
    if (child.kind === 'folder') yield* walk(child)
  }
}

// The parts of a dropped path, or null for one that tries to climb out ("../x.md").
function splitSource(source: string): string[] | null {
  const parts = source.replace(/\\/g, '/').split('/').filter((p) => p !== '' && p !== '.')
  return parts.includes('..') ? null : parts
}

// A folder's title from its name on the computer: "Getting Started" stays as
// it is; a name that's already a slug ("getting-started") reads "Getting started".
function folderTitle(original: string, name: string): string {
  const clean = original.trim().slice(0, 60)
  return clean === name ? titleFromName(name) : clean
}

export function planFolderUpload(input: {
  visibility: Visibility
  // The folder it's dropped on ("" for the top level).
  target: string
  entries: UploadEntry[]
  // The current tree for `visibility`.
  tree: PlanTree
  allowed: string[]
  maxBytes: number
}): PlanResult {
  const { visibility, target, tree, allowed, maxBytes } = input
  const problems: string[] = []
  const plan: UploadPlan = { folders: [], files: [], skipped: [] }

  const existingFolders = new Set<string>([''])
  const existingFiles = new Set<string>()
  // Public article names are their ids, unique across all of public/.
  const existingSlugs = new Map<string, string>()
  for (const node of walk(tree)) {
    if (node.kind === 'folder') existingFolders.add(node.path)
    else {
      existingFiles.add(node.path)
      if (node.name.endsWith('.md')) existingSlugs.set(slugFromFilename(node.name), node.path)
    }
  }
  if (!existingFolders.has(target)) return { ok: false, problems: ['That folder no longer exists. Refresh the page.'] }

  const newFolders = new Map<string, string>()
  const sources = new Map<string, string>()
  const uploadSlugs = new Map<string, string>()
  const tooDeep: string[] = []

  for (const entry of input.entries) {
    const source = entry.path
    const parts = splitSource(source)
    if (!parts?.length) {
      problems.push(`“${source}” isn’t a usable path.`)
      continue
    }
    if (parts.some((p) => p.startsWith('.'))) {
      plan.skipped.push({ source, reason: 'hidden' })
      continue
    }
    const fileName = parts.at(-1)!
    const ext = (/\.[A-Za-z0-9]+$/.exec(fileName)?.[0] ?? '').toLowerCase()
    if (!allowed.includes(ext)) {
      plan.skipped.push({ source, reason: 'type' })
      continue
    }
    if (entry.size === 0) {
      plan.skipped.push({ source, reason: 'empty' })
      continue
    }
    if (entry.size > maxBytes) {
      problems.push(`“${source}” is over ${Math.round(maxBytes / 1024 / 1024)} MB.`)
      continue
    }

    const folderParts = parts.slice(0, -1)
    if (depthOf(target) + folderParts.length > MAX_DEPTH) {
      tooDeep.push(`“${source}” would be more than ${MAX_DEPTH} folders deep.`)
      continue
    }
    let folder = target
    let usable = true
    for (const original of folderParts) {
      const name = folderName(original)
      if (!name) {
        problems.push(`“${original}” (in “${source}”) needs letters or numbers to be a folder name.`)
        usable = false
        break
      }
      folder = joinPath(folder, name)
      if (!existingFolders.has(folder) && !newFolders.has(folder)) newFolders.set(folder, folderTitle(original, name))
    }
    if (!usable) continue

    let name: string
    try {
      name = safeFileName(fileName, allowed)
    } catch {
      problems.push(`“${source}” needs letters or numbers in its name.`)
      continue
    }
    const path = joinPath(folder, name)
    try {
      parsePath(path, 'file')
    } catch {
      problems.push(`“${source}” has a name Desk can’t use.`)
      continue
    }
    const twin = sources.get(path)
    if (twin) {
      problems.push(`“${twin}” and “${source}” would both be saved as ${path}.`)
      continue
    }
    sources.set(path, source)

    if (visibility === 'public') {
      const slug = slugFromFilename(name)
      const taken = existingSlugs.get(slug)
      if (taken && taken !== path) {
        problems.push(`An article named “${slug}” already exists at ${taken}, so “${source}” can’t use that name.`)
        continue
      }
      const sibling = uploadSlugs.get(slug)
      if (sibling) {
        problems.push(`“${sibling}” and “${source}” would both be the article “${slug}”. Article names must be unique.`)
        continue
      }
      uploadSlugs.set(slug, source)
    }
    plan.files.push({ source, path, replaces: existingFiles.has(path) })
  }

  // A public folder and an article beside it can't share a name: both would be
  // /articles/<folder>/<name>. Check new folders against every article, and new
  // articles against every folder, existing or new.
  if (visibility === 'public') {
    const articleAt = new Set([...existingFiles, ...plan.files.map((f) => f.path)].filter((p) => p.endsWith('.md')).map((p) => p.slice(0, -3)))
    for (const folder of newFolders.keys()) {
      if (articleAt.has(folder)) problems.push(`The folder “${baseName(folder)}” would share a web address with the article ${folder}.md.`)
    }
    for (const file of plan.files) {
      const asFolder = file.path.slice(0, -3)
      if (!newFolders.has(asFolder) && existingFolders.has(asFolder)) {
        problems.push(`“${file.source}” would share a web address with the folder ${asFolder}.`)
      }
    }
  }

  // Into a folder that's already as deep as folders go, say so once.
  if (tooDeep.length) {
    if (depthOf(target) >= MAX_DEPTH) problems.unshift(`That folder is already ${MAX_DEPTH} levels deep, so folders can’t go inside it. Upload the files on their own.`)
    else problems.unshift(...tooDeep)
  }
  if (problems.length) return { ok: false, problems }
  if (!plan.files.length) {
    return { ok: false, problems: [visibility === 'public' ? 'There are no Markdown (.md) files to upload in that.' : 'There are no .md or .txt files to upload in that.'] }
  }
  if (plan.files.length > MAX_UPLOAD_FILES) return { ok: false, problems: [`Upload at most ${MAX_UPLOAD_FILES} files at a time.`] }
  // Browsers hand files over in no set order: write them alphabetically, so
  // each folder lists its new files by name.
  plan.files.sort((a, b) => a.path.localeCompare(b.path))

  // Only folders that end up holding a file, parents first.
  const used = new Set<string>()
  for (const file of plan.files) {
    for (let f = parentOf(file.path); f && f !== target; f = parentOf(f)) used.add(f)
  }
  plan.folders = [...newFolders]
    .filter(([path]) => used.has(path))
    .sort(([a], [b]) => depthOf(a) - depthOf(b) || a.localeCompare(b))
    .map(([path, title]) => ({ path, title }))
  return { ok: true, plan }
}

// One message for a refused upload: the first few problems, then a count.
export function describeProblems(problems: string[], show = 3): string {
  const shown = problems.slice(0, show).join(' ')
  const more = problems.length - show
  return more > 0 ? `${shown} And ${more} more problem${more === 1 ? '' : 's'}.` : shown
}

// What was skipped, for the message after an upload: "Skipped 3 files: 2 that
// aren't Markdown and 1 empty."
export function describeSkipped(skipped: UploadPlan['skipped'], visibility: Visibility): string {
  if (!skipped.length) return ''
  const count = (reason: UploadPlan['skipped'][number]['reason']) => skipped.filter((s) => s.reason === reason).length
  const parts = [
    count('type') && `${count('type')} that ${count('type') === 1 ? 'isn’t' : 'aren’t'} ${visibility === 'public' ? 'Markdown' : '.md or .txt'}`,
    count('hidden') && `${count('hidden')} hidden`,
    count('empty') && `${count('empty')} empty`,
  ].filter(Boolean) as string[]
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0]
  return `Skipped ${skipped.length} file${skipped.length === 1 ? '' : 's'}: ${list}.`
}

// Groups files into requests: at most BATCH_FILES files and BATCH_BYTES each,
// in order. A file bigger than the budget (up to the 1 MB cap) goes alone.
export function packBatches<T extends { size: number }>(files: T[], maxBytes = BATCH_BYTES, maxFiles = BATCH_FILES): T[][] {
  const batches: T[][] = []
  let current: T[] = []
  let bytes = 0
  for (const file of files) {
    if (current.length && (bytes + file.size > maxBytes || current.length >= maxFiles)) {
      batches.push(current)
      current = []
      bytes = 0
    }
    current.push(file)
    bytes += file.size
  }
  if (current.length) batches.push(current)
  return batches
}

// Every folder that `paths` sit in, each with its title from the plan (or one
// made from its name), parents first. Each batch creates the ones it needs.
export function foldersFor(paths: string[], titles: Record<string, string>): Array<{ path: string; title: string }> {
  const need = new Set<string>()
  for (const p of paths) for (let f = parentOf(p); f; f = parentOf(f)) need.add(f)
  return [...need].sort((a, b) => depthOf(a) - depthOf(b) || a.localeCompare(b)).map((path) => ({ path, title: titles[path] ?? titleFromName(baseName(path)) }))
}
