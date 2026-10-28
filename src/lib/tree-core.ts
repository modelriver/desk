// The data folder as a tree: folders inside public/ and private/, up to two
// levels deep (Billing › Invoices). Pure helpers, no I/O, so they can be tested
// directly; src/server/tree.server.ts does the reading and writing.
//
// Each folder may hold a hidden `.desk.json` with its display title and the
// order of what's inside it:  { "title": "Billing", "order": ["plans.md", "invoices"] }
// Anything not listed comes after the listed items, folders first, then by name.

export const META_FILE = '.desk.json'
export const MAX_DEPTH = 2

export interface FolderMeta {
  title?: string
  order?: string[]
}

const FOLDER = /^[a-z0-9][a-z0-9-]{0,59}$/
const FILE = /^[a-z0-9][a-z0-9-]{0,79}\.(md|txt)$/

export class PathError extends Error {}

// A folder name from a title: "Billing & invoices" -> "billing-invoices".
export function folderName(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

// Splits and validates a path inside public/ or private/: "billing/invoices"
// (a folder) or "billing/invoices/refunds.md" (a file). Every part must be a
// plain name: no "..", no absolute paths, no hidden files, no more than
// MAX_DEPTH folders. "" is the top level.
export function parsePath(rel: string, kind: 'folder' | 'file'): string[] {
  if (rel === '' && kind === 'folder') return []
  const parts = rel.split('/')
  const folders = kind === 'file' ? parts.slice(0, -1) : parts
  if (folders.length > MAX_DEPTH) throw new PathError(`Folders can only go ${MAX_DEPTH} levels deep.`)
  for (const f of folders) if (!FOLDER.test(f)) throw new PathError('Invalid folder name.')
  if (kind === 'file' && !FILE.test(parts.at(-1) ?? '')) throw new PathError('Invalid file name.')
  return parts
}

export function joinPath(...parts: string[]): string {
  return parts.filter(Boolean).join('/')
}

export function parentOf(rel: string): string {
  return rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
}

export function baseName(rel: string): string {
  return rel.slice(rel.lastIndexOf('/') + 1)
}

export function depthOf(folderRel: string): number {
  return folderRel ? folderRel.split('/').length : 0
}

// A folder's children in display order: what `.desk.json` lists, then the rest
// (folders before files, then by name). Names in the list that no longer exist are skipped.
export function orderChildren(names: Array<{ name: string; folder: boolean }>, order: string[] = []): string[] {
  const present = new Set(names.map((n) => n.name))
  const listed = order.filter((n, i) => present.has(n) && order.indexOf(n) === i)
  const rest = names
    .filter((n) => !listed.includes(n.name))
    .sort((a, b) => Number(b.folder) - Number(a.folder) || a.name.localeCompare(b.name))
    .map((n) => n.name)
  return [...listed, ...rest]
}

// The order after placing `name` just before `before` (or last when null).
// Works for a move within the folder and for an item arriving from elsewhere.
export function placeInOrder(order: string[], name: string, before: string | null): string[] {
  const without = order.filter((n) => n !== name)
  const at = before === null ? -1 : without.indexOf(before)
  if (at === -1) return [...without, name]
  return [...without.slice(0, at), name, ...without.slice(at)]
}

// Refuses moves that make no sense: a folder into itself or its own subfolder.
export function assertCanMove(from: string, toFolder: string) {
  if (toFolder === from || toFolder.startsWith(`${from}/`)) throw new PathError('A folder can’t go inside itself.')
}

export function parseMeta(json: string | null): FolderMeta {
  if (!json) return {}
  try {
    const data = JSON.parse(json) as unknown
    if (!data || typeof data !== 'object') return {}
    const { title, order } = data as Record<string, unknown>
    return {
      title: typeof title === 'string' && title.trim() ? title.trim().slice(0, 60) : undefined,
      order: Array.isArray(order) ? order.filter((n): n is string => typeof n === 'string').slice(0, 1000) : undefined,
    }
  } catch {
    return {}
  }
}

// A readable title for a folder that has none set: "billing-faq" -> "Billing faq".
export function titleFromName(name: string): string {
  const words = name.replace(/-/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}
