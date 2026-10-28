import { joinPath, parentOf, placeInOrder } from './tree-core.ts'

// Rearranging on a copy of the tree: the Data page applies moves here as you
// make them, and sends them to the server only when you save. The ordering
// rule is the server's (placeInOrder over the folder's current order), so
// what you see is what you get.

type Visibility = 'public' | 'private'

interface TreeFile {
  kind: 'file'
  name: string
  path: string
}
interface TreeFolder {
  kind: 'folder'
  name: string
  path: string
  children: Array<TreeFolder | TreeFile>
}

export interface Move {
  from: { visibility: Visibility; path: string; kind: 'folder' | 'file' }
  to: { visibility: Visibility; folder: string; before: string | null }
}

function find(root: TreeFolder, path: string): TreeFolder | TreeFile | null {
  if (root.path === path) return root
  for (const c of root.children) {
    if (c.path === path) return c
    if (c.kind === 'folder' && path.startsWith(`${c.path}/`)) return find(c, path)
  }
  return null
}

// A copy of the tree with the folder at `path` replaced by change(folder).
function updateFolder<F extends TreeFolder>(root: F, path: string, change: (f: F) => F): F {
  if (root.path === path) return change(root)
  return {
    ...root,
    children: root.children.map((c) => (c.kind === 'folder' && (path === c.path || path.startsWith(`${c.path}/`)) ? updateFolder(c as F, path, change) : c)),
  }
}

// The node at a new path, with everything inside it following.
function rebase<N extends TreeFolder | TreeFile>(node: N, path: string): N {
  if (node.kind === 'file') return { ...node, path }
  return { ...node, path, children: node.children.map((c) => rebase(c, joinPath(path, c.name))) }
}

export function applyMove<D extends Record<Visibility, TreeFolder>>(data: D, move: Move): { data: D; path: string } {
  const { from, to } = move
  const node = find(data[from.visibility], from.path)
  if (!node || node.kind !== from.kind) throw new Error('That item isn’t there any more.')
  const name = node.name
  const path = joinPath(to.folder, name)
  const moved = rebase(node, path)

  const without = updateFolder(data[from.visibility], parentOf(from.path), (f) => ({ ...f, children: f.children.filter((c) => c.name !== name) }))
  const next = { ...data, [from.visibility]: without } as D
  next[to.visibility] = updateFolder(next[to.visibility], to.folder, (f) => {
    const byName = new Map(f.children.map((c) => [c.name, c]))
    byName.set(name, moved)
    const order = placeInOrder(
      f.children.map((c) => c.name),
      name,
      to.before,
    )
    return { ...f, children: order.map((n) => byName.get(n)!) }
  }) as D[typeof to.visibility]
  return { data: next, path }
}
