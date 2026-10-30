// Selecting files on the Knowledge page to publish or unpublish them together.
// Pure helpers over the tree the page already has, so they can be tested
// directly. Only Markdown files can be selected: they're the ones with a
// draft status (plain-text notes have no front matter).

export interface SelectableFile {
  kind: 'file'
  name: string
  path: string
  title: string
  draft: boolean
}
export interface SelectableFolder {
  kind: 'folder'
  name: string
  path: string
  title: string
  children: Array<SelectableFolder | SelectableFile>
}
export type Visibility = 'public' | 'private'
export interface SelectionTree {
  public: SelectableFolder
  private: SelectableFolder
}

export const selectionKey = (visibility: Visibility, path: string) => `${visibility}:${path}`

export const canSelect = (file: SelectableFile) => file.name.endsWith('.md')

// Whether a file shows on the Knowledge page: its search ("" shows
// everything) and, in the Drafts view, only drafts.
export const matchesFilter = (file: SelectableFile, filter: string, draftsOnly = false) =>
  (!draftsOnly || file.draft) && (!filter || `${file.title} ${file.name}`.toLowerCase().includes(filter))

// The selectable files in a folder and everything under it that the page
// shows, as selection keys.
export function filesIn(visibility: Visibility, folder: SelectableFolder, filter = '', draftsOnly = false): string[] {
  return folder.children.flatMap((c) =>
    c.kind === 'folder'
      ? filesIn(visibility, c, filter, draftsOnly)
      : canSelect(c) && matchesFilter(c, filter, draftsOnly)
        ? [selectionKey(visibility, c.path)]
        : [],
  )
}

// A folder's checkbox: ticked when all its files are selected, a dash when some are.
export function folderState(keys: string[], selected: ReadonlySet<string>): 'all' | 'some' | 'none' {
  const count = keys.filter((k) => selected.has(k)).length
  return count === 0 ? 'none' : count === keys.length ? 'all' : 'some'
}

// Clicking a folder's checkbox: selects all of it, or clears it when it's all selected already.
export function toggleKeys(selected: ReadonlySet<string>, keys: string[]): Set<string> {
  const next = new Set(selected)
  if (keys.length && keys.every((k) => next.has(k))) for (const k of keys) next.delete(k)
  else for (const k of keys) next.add(k)
  return next
}

export interface SelectedFile {
  visibility: Visibility
  path: string
  title: string
  draft: boolean
}

// The selected files that still exist, in tree order, after the tree
// changes (a refresh, a delete, a move). Keys for files that are gone drop out.
export function selectedFiles(tree: SelectionTree, selected: ReadonlySet<string>): SelectedFile[] {
  if (!selected.size) return []
  const out: SelectedFile[] = []
  const walk = (visibility: Visibility, folder: SelectableFolder) => {
    for (const c of folder.children) {
      if (c.kind === 'folder') walk(visibility, c)
      else if (canSelect(c) && selected.has(selectionKey(visibility, c.path))) out.push({ visibility, path: c.path, title: c.title, draft: c.draft })
    }
  }
  walk('public', tree.public)
  walk('private', tree.private)
  return out
}

// Every draft in the tree that the search shows, for the Drafts view's count.
export function draftKeys(tree: SelectionTree, filter = ''): string[] {
  const out: string[] = []
  const walk = (visibility: Visibility, folder: SelectableFolder) => {
    for (const c of folder.children) {
      if (c.kind === 'folder') walk(visibility, c)
      else if (canSelect(c) && c.draft && matchesFilter(c, filter)) out.push(selectionKey(visibility, c.path))
    }
  }
  walk('public', tree.public)
  walk('private', tree.private)
  return out
}
