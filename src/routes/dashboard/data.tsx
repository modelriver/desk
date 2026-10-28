import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { createFileRoute, Link, redirect, useBlocker, useNavigate, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { createDataFolder, deleteDataItem, getDataTree, moveDataItem, renameDataFolder, setArticleStatus, uploadFile } from '../../functions/data.ts'
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BookIcon,
  ChevronRightIcon,
  CopyIcon,
  ExternalIcon,
  EyeIcon,
  EyeOffIcon,
  FileIcon,
  FilePlusIcon,
  FolderIcon,
  FolderPlusIcon,
  GripIcon,
  LockIcon,
  MoveIcon,
  PencilIcon,
  SearchIcon,
  SendIcon,
  TrashIcon,
  UploadIcon,
  XIcon,
} from '../../components/icons.tsx'
import { ActionsMenu, type MenuItem } from '../../components/ActionsMenu.tsx'
import { FilePreview } from '../../components/FilePreview.tsx'
import { ConfirmDialog, MoveDialog, type FolderChoice } from '../../components/DataDialogs.tsx'
import { LoadError } from '../../components/LoadError.tsx'
import { RelativeTime } from '../../components/RelativeTime.tsx'
import { Button, PageHeader } from '../../components/ui.tsx'
import { shortcutLabel, Tooltip } from '../../components/Tooltip.tsx'
import { cn } from '../../lib/cn.ts'
import { applyMove, type Move } from '../../lib/tree-edit.ts'
import { helpPath } from '../../lib/help-path.ts'
import { BusyIcon } from '../../components/BusyIcon.tsx'
import { errorMessage } from '../../lib/errors.ts'

// The knowledge base: everything the help center and the AI answer from, as
// two trees (Public = help-center articles, Private = internal notes). Folders
// in Public are help-center sections. Drag to arrange; every drag has a menu
// equivalent (Move to…, Move up/down) for keyboards and touch screens.

export const Route = createFileRoute('/dashboard/data')({
  beforeLoad: ({ context }) => {
    if (context.user.role !== 'admin') throw redirect({ to: '/dashboard' })
  },
  loader: () => getDataTree(),
  errorComponent: ({ error }) => (
    <>
      <PageHeader title="Data" />
      <LoadError title="Couldn’t read the data folder" error={error} />
    </>
  ),
  component: DataPage,
})

type Data = Awaited<ReturnType<typeof getDataTree>>
type Folder = Data['public']
type FileItem = Extract<Folder['children'][number], { kind: 'file' }>
type Node = Folder | FileItem
type Visibility = 'public' | 'private'

interface Item {
  visibility: Visibility
  path: string
  kind: 'folder' | 'file'
  name: string
  title: string
}

interface Row {
  key: string
  visibility: Visibility
  node: Node
  depth: number
  parent: string
  // Names in the parent, in order, so a drop can say "before which".
  siblings: string[]
  index: number
}

type DropAt = 'before' | 'after' | 'into'

const MAX_DEPTH = 2
const ROOTS: Record<Visibility, { title: string; detail: string; icon: typeof BookIcon; newLabel: string }> = {
  public: {
    title: 'Public',
    detail: 'Help-center articles, shown to everyone and cited by the AI. Folders become sections.',
    icon: BookIcon,
    newLabel: 'New article',
  },
  private: {
    title: 'Private',
    detail: 'Internal notes. The AI uses them but never shows, quotes or links them.',
    icon: LockIcon,
    newLabel: 'New note',
  },
}

const keyOf = (visibility: Visibility, path: string) => `${visibility}:${path}`
const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')
const depthOf = (folder: string) => (folder ? folder.split('/').length : 0)
const subtreeDepth = (f: Folder): number => {
  const subs = f.children.filter((c): c is Folder => c.kind === 'folder')
  return subs.length ? 1 + Math.max(...subs.map(subtreeDepth)) : 0
}
const countFiles = (f: Folder): number => f.children.reduce((n, c) => n + (c.kind === 'file' ? 1 : countFiles(c)), 0)
const itemOf = (visibility: Visibility, node: Node): Item => ({ visibility, path: node.path, kind: node.kind, name: node.name, title: node.title })

function findNode(root: Folder, path: string): Node | null {
  if (root.path === path) return root
  for (const c of root.children) {
    if (c.path === path) return c
    if (c.kind === 'folder' && path.startsWith(`${c.path}/`)) return findNode(c, path)
  }
  return null
}

// Why `item` can't go into `folder`, or null when it can.
function dropProblem(data: Data, item: Item, visibility: Visibility, folder: string): string | null {
  if (item.kind === 'folder') {
    if (item.visibility === visibility && (folder === item.path || folder.startsWith(`${item.path}/`))) return 'A folder can’t go inside itself.'
    const node = findNode(data[item.visibility], item.path)
    if (node?.kind === 'folder' && depthOf(folder) + 1 + subtreeDepth(node) > MAX_DEPTH) return 'Folders go at most two levels deep.'
    if (visibility === 'public' && node?.kind === 'folder' && containsText(node)) return 'Text notes can’t be help-center articles.'
  } else if (visibility === 'public' && item.name.endsWith('.txt')) {
    return 'Text notes can’t be help-center articles.'
  }
  if (item.visibility !== visibility || parentOf(item.path) !== folder) {
    const target = findNode(data[visibility], folder)
    if (target?.kind === 'folder' && target.children.some((c) => c.name === item.name)) return `There’s already a “${item.name}” in that folder.`
    if (visibility === 'public' && target?.kind === 'folder') {
      const slug = item.kind === 'file' ? item.name.replace(/\.md$/, '') : null
      const clash = target.children.some((c) => (item.kind === 'folder' ? c.kind === 'file' && c.slug === item.name : c.kind === 'folder' && c.name === slug))
      if (clash) return `“${item.title}” would share a web address with ${item.kind === 'folder' ? 'an article' : 'a folder'} there.`
    }
    if (item.kind === 'file' && visibility === 'public' && item.visibility === 'private' && hasFileNamed(data.public, item.name)) {
      return `The help center already has an article named “${item.name}”.`
    }
  }
  return null
}
const hasFileNamed = (f: Folder, name: string): boolean => f.children.some((c) => (c.kind === 'file' ? c.name === name : hasFileNamed(c, name)))
const containsText = (f: Folder): boolean => f.children.some((c) => (c.kind === 'file' ? c.name.endsWith('.txt') : containsText(c)))

// --- Collapsed folders, remembered per browser ---

const COLLAPSED_KEY = 'desk-data-collapsed'
function useCollapsed() {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  useEffect(() => {
    try {
      setCollapsed(new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]') as string[]))
    } catch {
      // Private browsing or bad data: start with everything open.
    }
  }, [])
  const toggle = useCallback((key: string, open?: boolean) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (open ?? next.has(key)) next.delete(key)
      else next.add(key)
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]))
      } catch {
        // Not remembered; still works for this visit.
      }
      return next
    })
  }, [])
  return { collapsed, toggle }
}

// Rearranging happens on a copy: moves show at once but reach the files (and
// the help center) only on Save. Undo steps back one move; Cancel drops all.
interface Arrangement {
  draft: Data
  moves: Move[]
  // Keys of items moved so far, to mark them.
  moved: Set<string>
  history: Array<Omit<Arrangement, 'history'>>
}

function DataPage() {
  const data = Route.useLoaderData()
  const router = useRouter()
  const navigate = useNavigate()
  const move = useServerFn(moveDataItem)
  const makeFolder = useServerFn(createDataFolder)
  const rename = useServerFn(renameDataFolder)
  const remove = useServerFn(deleteDataItem)
  const upload = useServerFn(uploadFile)
  const setStatus$ = useServerFn(setArticleStatus)

  const { collapsed, toggle } = useCollapsed()
  const [filter, setFilter] = useState('')
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<{ kind: 'rename'; key: string } | { kind: 'new-folder'; visibility: Visibility; parent: string } | null>(null)
  const [deleting, setDeleting] = useState<(Item & { files: number }) | null>(null)
  // Publish or Unpublish from a file's menu, waiting for a yes.
  const [statusChange, setStatusChange] = useState<{ item: Item; status: 'published' | 'draft'; title: string } | null>(null)
  const [moving, setMoving] = useState<Item | null>(null)
  const [previewing, setPreviewing] = useState<{ visibility: Visibility; path: string; name: string } | null>(null)
  const [uploadTarget, setUploadTarget] = useState<{ visibility: Visibility; folder: string } | null>(null)
  const [arrangement, setArrangement] = useState<Arrangement | null>(null)
  const [discarding, setDiscarding] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  const arranging = arrangement !== null
  const changes = arrangement?.moves.length ?? 0
  // What's on screen: the saved tree, or the arrangement being made.
  const view = arrangement?.draft ?? data

  // Status messages fade after a while.
  useEffect(() => {
    if (!status) return
    const timer = setTimeout(() => setStatus(null), 6_000)
    return () => clearTimeout(timer)
  }, [status])

  const run = async (fn: () => Promise<{ text: string } | void>) => {
    setBusy(true)
    try {
      const result = await fn()
      await router.invalidate()
      if (result) setStatus({ ok: true, ...result })
      return true
    } catch (err) {
      setStatus({ ok: false, text: errorMessage(err, 'Something went wrong.') })
      return false
    } finally {
      setBusy(false)
    }
  }

  const startArranging = () => {
    setFilter('')
    setEditing(null)
    setStatus(null)
    setArrangement({ draft: data, moves: [], moved: new Set(), history: [] })
  }
  const stopArranging = () => {
    setArrangement(null)
    setDiscarding(false)
  }
  const cancelArranging = () => (changes ? setDiscarding(true) : stopArranging())

  // Stages a move on the copy (only while arranging).
  const moveItem = (item: Item, to: { visibility: Visibility; folder: string; before: string | null }) => {
    if (!arrangement) return
    const from = parentOf(item.path)
    const parent = findNode(view[item.visibility], from) as Folder
    const index = parent.children.findIndex((c) => c.name === item.name)
    const wasBefore = parent.children[index + 1]?.name ?? null
    if (item.visibility === to.visibility && from === to.folder && (to.before === item.name || to.before === wasBefore)) return
    const problem = dropProblem(view, item, to.visibility, to.folder)
    if (problem) return setStatus({ ok: false, text: problem })
    const step: Move = { from: { visibility: item.visibility, path: item.path, kind: item.kind }, to }
    const { data: draft, path } = applyMove(view, step)
    const moved = new Set(arrangement.moved)
    moved.delete(keyOf(item.visibility, item.path))
    moved.add(keyOf(to.visibility, path))
    const { history, ...current } = arrangement
    setArrangement({ draft, moves: [...arrangement.moves, step], moved, history: [...history, current] })
    // Open the folder it went into, so it's visible there.
    if (to.folder) toggle(keyOf(to.visibility, to.folder), true)
  }

  const undoMove = () => {
    if (!arrangement?.history.length || busy) return
    const previous = arrangement.history.at(-1)!
    setArrangement({ ...previous, history: arrangement.history.slice(0, -1) })
  }

  // Sends the moves in the order they were made, so each path is valid when it's applied.
  const saveArrangement = async () => {
    if (!arrangement || !changes || busy) return
    setBusy(true)
    let done = 0
    try {
      for (const step of arrangement.moves) {
        await move({ data: step })
        done++
      }
      setStatus({ ok: true, text: changes === 1 ? 'Saved 1 change.' : `Saved ${changes} changes.` })
    } catch (err) {
      const reason = errorMessage(err, 'Something went wrong.')
      setStatus({ ok: false, text: done ? `Saved ${done} of ${changes} changes, then stopped: ${reason}` : `Nothing was saved: ${reason}` })
    } finally {
      await router.invalidate()
      setArrangement(null)
      setBusy(false)
    }
  }

  // While arranging: ⌘S saves, ⌘Z undoes, Escape cancels.
  const keys = useRef({ save: saveArrangement, undo: undoMove, cancel: cancelArranging })
  keys.current = { save: saveArrangement, undo: undoMove, cancel: cancelArranging }
  useEffect(() => {
    if (!arranging) return
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && e.target.closest('input, textarea, dialog')) return
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void keys.current.save()
      } else if (mod && !e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        keys.current.undo()
      } else if (e.key === 'Escape') {
        keys.current.cancel()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [arranging])

  // Leaving with an unsaved arrangement asks first.
  const blocker = useBlocker({ shouldBlockFn: () => changes > 0, enableBeforeUnload: () => changes > 0, withResolver: true })

  const uploadFiles = (files: FileList, visibility: Visibility, folder: string) => {
    const list = [...files]
    if (!list.length) return
    void run(async () => {
      for (const file of list) {
        const form = new FormData()
        form.set('visibility', visibility)
        form.set('folder', folder)
        form.set('file', file)
        await upload({ data: form })
      }
      return { text: list.length === 1 ? `Uploaded ${list[0]!.name}.` : `Uploaded ${list.length} files.` }
    })
  }

  // Every folder, for "Move to…".
  const folderChoices = useMemo(() => {
    const out: FolderChoice[] = []
    const walk = (visibility: Visibility, f: Folder, depth: number) => {
      out.push({ visibility, path: f.path, title: depth === 0 ? ROOTS[visibility].title : f.title, depth })
      for (const c of f.children) if (c.kind === 'folder') walk(visibility, c, depth + 1)
    }
    walk('public', view.public, 0)
    walk('private', view.private, 0)
    return out
  }, [view])

  const shared: TreeShared = {
    data: view,
    arranging,
    moved: arrangement?.moved ?? NO_KEYS,
    collapsed,
    toggle,
    filter: filter.trim().toLowerCase(),
    busy,
    editing,
    setEditing,
    onMove: moveItem,
    onUpload: uploadFiles,
    onRename: (visibility, path, title) => void run(async () => (await rename({ data: { visibility, path, title } }), { text: `Renamed to “${title}”.` })),
    onCreateFolder: (visibility, parent, title) =>
      void run(async () => {
        const { path } = await makeFolder({ data: { visibility, parent, title } })
        toggle(keyOf(visibility, parent), true)
        toggle(keyOf(visibility, path), true)
        return { text: `Created “${title}”.` }
      }),
    onDelete: (item) => {
      const node = findNode(data[item.visibility], item.path)
      setDeleting({ ...item, files: node?.kind === 'folder' ? countFiles(node) : 1 })
    },
    onPickMove: setMoving,
    onPreview: (item) => setPreviewing({ visibility: item.visibility, path: item.path, name: item.name }),
    onSetStatus: (item, status, title) => setStatusChange({ item, status, title }),
    onAskUpload: (visibility, folder) => {
      setUploadTarget({ visibility, folder })
      fileInput.current?.click()
    },
    onNewArticle: (visibility, folder) => void navigate({ to: '/dashboard/editor', search: { visibility, folder } }),
    onStatus: (text) => setStatus({ ok: true, text }),
    onProblem: (text) => setStatus({ ok: false, text }),
  }

  return (
    <>
      <PageHeader
        title="Data"
        description="What the help center and the AI answer from. Published changes go live straight away; drafts stay out until you publish them."
        actions={
          arranging ? undefined : (
            <>
              <Tooltip content="Reorder, or move things between folders">
                <Button variant="outline" onClick={startArranging}>
                  <MoveIcon size={15} />
                  Arrange
                </Button>
              </Tooltip>
              <Tooltip content="Add a section to the help center">
                <Button variant="outline" onClick={() => setEditing({ kind: 'new-folder', visibility: 'public', parent: '' })}>
                  <FolderPlusIcon size={15} />
                  New folder
                </Button>
              </Tooltip>
              <Tooltip content="Write a help-center article">
                <Button onClick={() => void navigate({ to: '/dashboard/editor', search: { visibility: 'public', folder: '' } })}>
                  <FilePlusIcon size={15} />
                  New article
                </Button>
              </Tooltip>
            </>
          )
        }
      />

      <input
        ref={fileInput}
        type="file"
        multiple
        accept=".md,.txt,text/markdown,text/plain"
        className="hidden"
        onChange={(e) => {
          if (uploadTarget && e.target.files) uploadFiles(e.target.files, uploadTarget.visibility, uploadTarget.folder)
          e.target.value = ''
        }}
      />

      {arranging ? (
        <div
          role="region"
          aria-label="Arranging"
          className="sticky top-3 z-30 mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-primary/50 bg-card px-4 py-3 shadow-md"
        >
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">Arranging</p>
            <p className="text-xs text-muted-foreground">Drag items, or use their menu to move them. The help center doesn’t change until you save.</p>
          </div>
          <span className="text-sm text-muted-foreground tabular-nums" aria-live="polite">
            {changes === 0 ? 'No changes yet' : changes === 1 ? '1 change' : `${changes} changes`}
          </span>
          <div className="flex items-center gap-1.5">
            <Tooltip content="Undo the last move" shortcut={shortcutLabel('Z')}>
              <Button variant="ghost" size="sm" onClick={undoMove} aria-disabled={!arrangement.history.length || busy} className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50">
                Undo
              </Button>
            </Tooltip>
            <Tooltip content="Put everything back as it was" shortcut="Esc">
              <Button variant="outline" size="sm" onClick={cancelArranging} disabled={busy}>
                Cancel
              </Button>
            </Tooltip>
            <Tooltip content={changes ? 'Apply the new arrangement to the help center' : 'Move something first'} shortcut={shortcutLabel('S')}>
              <Button size="sm" onClick={() => void saveArrangement()} aria-disabled={!changes || busy} className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50">
                <BusyIcon busy={busy} size={14} />
                Save changes
              </Button>
            </Tooltip>
          </div>
        </div>
      ) : (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div className="relative w-full max-w-xs">
            <SearchIcon size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground" />
            <label htmlFor="data-filter" className="sr-only">
              Filter files
            </label>
            <input
              id="data-filter"
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by title or file name"
              className="h-9 w-full rounded-md border border-input bg-card pr-3 pl-9 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring"
            />
          </div>
          <p className="text-xs text-muted-foreground">To reorder or move things, use Arrange. Drop files from your computer onto a folder to upload them.</p>
        </div>
      )}

      {status && (
        <div
          role={status.ok ? 'status' : 'alert'}
          className={cn(
            'mb-4 flex items-center gap-3 rounded-lg border px-3.5 py-2 text-sm shadow-sm',
            !arranging && 'sticky top-3 z-30',
            status.ok ? 'border-border bg-card' : 'border-destructive/30 bg-destructive/5 text-destructive',
          )}
        >
          <span className="min-w-0 flex-1">{status.text}</span>
          <Tooltip content="Dismiss">
            <button type="button" aria-label="Dismiss" onClick={() => setStatus(null)} className="text-muted-foreground hover:text-foreground">
              <XIcon size={14} />
            </button>
          </Tooltip>
        </div>
      )}

      <div className="grid gap-6">
        <Tree visibility="public" root={view.public} shared={shared} />
        <Tree visibility="private" root={view.private} shared={shared} />
      </div>

      <MoveDialog
        open={moving !== null}
        itemTitle={moving?.title ?? ''}
        current={moving ? { visibility: moving.visibility, path: parentOf(moving.path) } : null}
        choices={folderChoices.map((c) => ({ ...c, disabled: moving ? (dropProblem(view, moving, c.visibility, c.path) ?? undefined) : undefined }))}
        busy={busy}
        onClose={() => setMoving(null)}
        onMove={(target) => {
          if (moving) moveItem(moving, { visibility: target.visibility, folder: target.path, before: null })
          setMoving(null)
        }}
      />
      <ConfirmDialog
        open={discarding}
        title={`Discard ${changes === 1 ? 'this change' : `${changes} changes`}?`}
        confirmLabel="Discard"
        onClose={() => setDiscarding(false)}
        onConfirm={stopArranging}
      >
        Everything goes back to how it was. Nothing on the help center has changed.
      </ConfirmDialog>
      <ConfirmDialog
        open={blocker.status === 'blocked'}
        title="Leave without saving the new arrangement?"
        confirmLabel="Leave"
        onClose={() => blocker.reset?.()}
        onConfirm={() => blocker.proceed?.()}
      >
        Your {changes === 1 ? 'change' : `${changes} changes`} will be lost.
      </ConfirmDialog>
      <ConfirmDialog
        open={statusChange !== null}
        tone="primary"
        busy={busy}
        title={statusChange?.status === 'draft' ? `Unpublish “${statusChange.title}”?` : `Publish “${statusChange?.title ?? ''}”?`}
        confirmLabel={statusChange?.status === 'draft' ? 'Unpublish' : 'Publish'}
        onClose={() => setStatusChange(null)}
        onConfirm={() => {
          if (!statusChange) return
          const { item, status, title } = statusChange
          void run(async () => {
            await setStatus$({ data: { visibility: item.visibility, path: item.path, status } })
            setStatusChange(null)
            return {
              text:
                status === 'draft'
                  ? `“${title}” is a draft now: it’s out of the ${item.visibility === 'public' ? 'help center and the ' : ''}AI’s answers.`
                  : `Published “${title}”.`,
            }
          })
        }}
      >
        {statusChange?.status === 'draft' ? (
          <>
            {statusChange.item.visibility === 'public' ? 'It comes off the help center and the AI stops using it.' : 'The AI stops using it.'} It
            stays here as a draft, and you can publish it again any time.
          </>
        ) : statusChange?.item.visibility === 'public' ? (
          <>
            It goes live on the help center at{' '}
            <span className="font-mono text-xs">/help/{helpPath(statusChange.item.path, statusChange.item.path.slice(statusChange.item.path.lastIndexOf('/') + 1).replace(/\.md$/, ''))}</span>,
            and the AI starts answering from it.
          </>
        ) : (
          'The AI starts answering from it. Private notes are never shown to visitors.'
        )}
      </ConfirmDialog>
      <ConfirmDialog
        open={deleting !== null}
        title={deleting?.kind === 'folder' ? `Delete the folder “${deleting.title}”?` : `Delete “${deleting?.title ?? ''}”?`}
        confirmLabel="Delete"
        busy={busy}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (!deleting) return
          const item = deleting
          void run(async () => {
            await remove({ data: { visibility: item.visibility, path: item.path, kind: item.kind } })
            setDeleting(null)
            return { text: `Deleted “${item.title}”.` }
          })
        }}
      >
        {deleting?.kind === 'folder'
          ? deleting.files
            ? `It holds ${deleting.files} file${deleting.files === 1 ? '' : 's'}, which will be deleted too.`
            : 'It’s empty.'
          : deleting?.visibility === 'public'
            ? 'It disappears from the help center and the AI stops using it.'
            : 'The AI stops using it.'}{' '}
        This can’t be undone.
      </ConfirmDialog>
      <FilePreview file={previewing} onClose={() => setPreviewing(null)} />
    </>
  )
}

const NO_KEYS = new Set<string>()

interface TreeShared {
  data: Data
  // Arrange mode: rows can be dragged and moved; nothing else changes.
  arranging: boolean
  moved: Set<string>
  collapsed: Set<string>
  toggle: (key: string, open?: boolean) => void
  filter: string
  busy: boolean
  editing: { kind: 'rename'; key: string } | { kind: 'new-folder'; visibility: Visibility; parent: string } | null
  setEditing: (e: TreeShared['editing']) => void
  onMove: (item: Item, to: { visibility: Visibility; folder: string; before: string | null }) => void
  onUpload: (files: FileList, visibility: Visibility, folder: string) => void
  onRename: (visibility: Visibility, path: string, title: string) => void
  onCreateFolder: (visibility: Visibility, parent: string, title: string) => void
  onDelete: (item: Item) => void
  onPickMove: (item: Item) => void
  onPreview: (item: Item) => void
  // Publish a draft, or Unpublish: move a published file back to draft.
  onSetStatus: (item: Item, status: 'published' | 'draft', title: string) => void
  onAskUpload: (visibility: Visibility, folder: string) => void
  onNewArticle: (visibility: Visibility, folder: string) => void
  onStatus: (text: string) => void
  onProblem: (text: string) => void
}

// The item being dragged, shared by every row (a drag can cross trees).
const dragging: { current: Item | null } = { current: null }

function Tree({ visibility, root, shared }: { visibility: Visibility; root: Folder; shared: TreeShared }) {
  const { collapsed, filter } = shared
  const [drop, setDrop] = useState<{ key: string; at: DropAt; problem: string | null } | null>(null)
  const expandTimer = useRef<{ key: string; timer: ReturnType<typeof setTimeout> } | null>(null)
  const meta = ROOTS[visibility]
  const Icon = meta.icon

  // Rows in display order: open folders show their contents. A filter shows
  // matching files with the folders around them, opened.
  const rows = useMemo(() => {
    const out: Row[] = []
    const matches = (n: Node): boolean =>
      n.kind === 'file' ? `${n.title} ${n.name}`.toLowerCase().includes(filter) : n.title.toLowerCase().includes(filter) || n.children.some(matches)
    const walk = (f: Folder, depth: number) => {
      const visible = filter ? f.children.filter(matches) : f.children
      const siblings = f.children.map((c) => c.name)
      visible.forEach((node) => {
        out.push({ key: keyOf(visibility, node.path), visibility, node, depth, parent: f.path, siblings, index: siblings.indexOf(node.name) })
        if (node.kind === 'folder' && (filter || !collapsed.has(keyOf(visibility, node.path)))) walk(node, depth + 1)
      })
    }
    walk(root, 0)
    return out
  }, [root, collapsed, filter, visibility])

  const clearDrop = () => {
    setDrop(null)
    if (expandTimer.current) clearTimeout(expandTimer.current.timer)
    expandTimer.current = null
  }

  // Where a drop over `row` would land, from the pointer's height within it.
  const targetFor = (row: Row | null, at: DropAt) => {
    if (!row) return { folder: '', before: null as string | null }
    if (at === 'into') return { folder: row.node.path, before: null }
    if (at === 'before') return { folder: row.parent, before: row.node.name }
    return { folder: row.parent, before: row.siblings[row.index + 1] ?? null }
  }

  const onDragOver = (e: DragEvent, row: Row | null) => {
    // Files from the computer upload outside Arrange; rows move only inside it.
    const external = !shared.arranging && e.dataTransfer.types.includes('Files') && !dragging.current
    const item = dragging.current
    if (!external && !item) return
    let at: DropAt = 'into'
    if (row && !external) {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
      const y = (e.clientY - rect.top) / rect.height
      at = row.node.kind === 'folder' ? (y < 0.25 ? 'before' : y > 0.75 ? 'after' : 'into') : y < 0.5 ? 'before' : 'after'
    }
    // Files from the computer go into the folder under the pointer (or the file's folder).
    const target = external && row && row.node.kind === 'file' ? { folder: row.parent, before: null } : targetFor(row, at)
    const problem = item ? dropProblem(shared.data, item, visibility, target.folder) : null
    e.preventDefault()
    e.dataTransfer.dropEffect = problem ? 'none' : external ? 'copy' : 'move'
    const key = external && row?.node.kind === 'file' ? keyOf(visibility, row.parent) : row ? row.key : keyOf(visibility, '')
    const dropAt: DropAt = external ? 'into' : at
    if (drop?.key !== key || drop.at !== dropAt || drop.problem !== problem) setDrop({ key, at: dropAt, problem })

    // Hovering over a closed folder opens it, so things can go deeper.
    if (row?.node.kind === 'folder' && dropAt === 'into' && collapsed.has(row.key)) {
      if (expandTimer.current?.key !== row.key) {
        if (expandTimer.current) clearTimeout(expandTimer.current.timer)
        expandTimer.current = { key: row.key, timer: setTimeout(() => shared.toggle(row.key, true), 600) }
      }
    }
  }

  const onDrop = (e: DragEvent, row: Row | null) => {
    e.preventDefault()
    const item = dragging.current
    const current = drop
    clearDrop()
    if (!item && e.dataTransfer.files.length) {
      const folder = row ? (row.node.kind === 'folder' ? row.node.path : row.parent) : ''
      shared.onUpload(e.dataTransfer.files, visibility, folder)
      return
    }
    if (!item || !current || current.problem) {
      if (current?.problem) shared.onProblem(current.problem)
      return
    }
    shared.onMove(item, { visibility, ...targetFor(row, current.at) })
  }

  const newFolderHere = shared.editing?.kind === 'new-folder' && shared.editing.visibility === visibility ? shared.editing.parent : null

  return (
    <section aria-labelledby={`tree-${visibility}`} className="rounded-xl border border-border bg-card">
      <div
        onDragOver={(e) => onDragOver(e, null)}
        onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Element) && clearDrop()}
        onDrop={(e) => onDrop(e, null)}
        className={cn(
          'flex flex-wrap items-center gap-3 rounded-t-xl border-b border-border px-4 py-3',
          drop?.key === keyOf(visibility, '') && (drop.problem ? 'bg-destructive/5' : 'bg-primary/5 ring-2 ring-primary ring-inset'),
        )}
      >
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground" aria-hidden="true">
          <Icon size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id={`tree-${visibility}`} className="text-sm font-semibold">
            {meta.title} <span className="font-normal text-muted-foreground">{countFiles(root)}</span>
          </h2>
          <p className="text-xs text-muted-foreground">{meta.detail}</p>
        </div>
        <div className={cn('flex items-center gap-1', shared.arranging && 'hidden')}>
          <Tooltip content={visibility === 'public' ? 'Write an article for the help center' : 'Write an internal note for the AI'}>
            <Button variant="ghost" size="sm" onClick={() => shared.onNewArticle(visibility, '')}>
              <FilePlusIcon size={14} />
              {meta.newLabel}
            </Button>
          </Tooltip>
          <Tooltip content="New folder">
            <Button variant="ghost" size="icon-sm" aria-label={`New folder in ${meta.title}`} onClick={() => shared.setEditing({ kind: 'new-folder', visibility, parent: '' })}>
              <FolderPlusIcon size={15} />
            </Button>
          </Tooltip>
          <Tooltip content={visibility === 'public' ? 'Upload Markdown (.md) files' : 'Upload .md or .txt files'}>
            <Button variant="ghost" size="icon-sm" aria-label={`Upload files to ${meta.title}`} onClick={() => shared.onAskUpload(visibility, '')}>
              <UploadIcon size={15} />
            </Button>
          </Tooltip>
        </div>
      </div>

      <ul className="py-1.5" onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Element) && clearDrop()}>
        {newFolderHere === '' && <NewFolderRow depth={0} shared={shared} visibility={visibility} parent="" />}
        {rows.map((row) => (
          <TreeRow
            key={row.key}
            row={row}
            shared={shared}
            drop={drop?.key === row.key ? drop : null}
            onDragOver={(e) => onDragOver(e, row)}
            onDrop={(e) => onDrop(e, row)}
            onDragEnd={clearDrop}
            newFolderInside={newFolderHere === row.node.path && row.node.kind === 'folder'}
          />
        ))}
        {rows.length === 0 && newFolderHere === null && (
          <li className="px-4 py-8 text-center text-sm text-muted-foreground">
            {filter ? 'Nothing matches the filter.' : visibility === 'public' ? 'No articles yet. Write one, or drop Markdown files here.' : 'No notes yet. Write one, or drop .md or .txt files here.'}
          </li>
        )}
      </ul>
    </section>
  )
}

function TreeRow({
  row,
  shared,
  drop,
  onDragOver,
  onDrop,
  onDragEnd,
  newFolderInside,
}: {
  row: Row
  shared: TreeShared
  drop: { at: DropAt; problem: string | null } | null
  onDragOver: (e: DragEvent) => void
  onDrop: (e: DragEvent) => void
  onDragEnd: () => void
  newFolderInside: boolean
}) {
  const { node, visibility, depth } = row
  const navigate = useNavigate()
  const item = itemOf(visibility, node)
  const isFolder = node.kind === 'folder'
  const open = isFolder && (shared.filter !== '' || !shared.collapsed.has(row.key))
  const renaming = shared.editing?.kind === 'rename' && shared.editing.key === row.key
  const indent = { paddingLeft: `${0.75 + depth * 1.5}rem` }
  const editorSearch = { visibility, path: node.path }

  const moveBy = (step: -1 | 1) => {
    const target = row.index + step
    if (target < 0 || target >= row.siblings.length) return
    // Up: before the previous one. Down: before the one after next (or last).
    const before = step === -1 ? row.siblings[target]! : (row.siblings[target + 1] ?? null)
    shared.onMove(item, { visibility, folder: row.parent, before })
  }

  const moveMenu: MenuItem[] = [
    { label: 'Move to…', icon: <MoveIcon size={15} />, onSelect: () => shared.onPickMove(item) },
    { label: 'Move up', icon: <ArrowUpIcon size={15} />, disabled: row.index === 0, onSelect: () => moveBy(-1) },
    { label: 'Move down', icon: <ArrowDownIcon size={15} />, disabled: row.index === row.siblings.length - 1, onSelect: () => moveBy(1) },
  ]
  const menu: MenuItem[] = shared.arranging
    ? moveMenu
    : isFolder
      ? [
          { label: ROOTS[visibility].newLabel + ' here', icon: <FilePlusIcon size={15} />, onSelect: () => shared.onNewArticle(visibility, node.path) },
          ...(depth + 1 < MAX_DEPTH
            ? [{ label: 'New subfolder', icon: <FolderPlusIcon size={15} />, onSelect: () => (shared.toggle(row.key, true), shared.setEditing({ kind: 'new-folder', visibility, parent: node.path })) }]
            : []),
          { label: 'Upload files here', icon: <UploadIcon size={15} />, onSelect: () => shared.onAskUpload(visibility, node.path) },
          'separator',
          { label: 'Rename', icon: <PencilIcon size={15} />, onSelect: () => shared.setEditing({ kind: 'rename', key: row.key }) },
          'separator',
          { label: 'Delete folder', icon: <TrashIcon size={15} />, destructive: true, onSelect: () => shared.onDelete(item) },
        ]
      : [
          { label: 'Edit', icon: <PencilIcon size={15} />, onSelect: () => void navigate({ to: '/dashboard/editor', search: editorSearch }) },
          { label: 'Preview', icon: <EyeIcon size={15} />, onSelect: () => shared.onPreview(item) },
          // Only Markdown files can be drafts: plain-text notes have no front matter.
          ...(node.kind === 'file' && node.name.endsWith('.md')
            ? [
                node.draft
                  ? { label: 'Publish', icon: <SendIcon size={15} />, onSelect: () => shared.onSetStatus(item, 'published', node.title) }
                  : { label: 'Unpublish', icon: <EyeOffIcon size={15} />, onSelect: () => shared.onSetStatus(item, 'draft', node.title) },
              ]
            : []),
          // A draft isn't on the help center yet, so there's nothing to open or link to.
          ...(visibility === 'public' && node.kind === 'file' && !node.draft
            ? [
                { label: 'Open in help center', icon: <ExternalIcon size={15} />, onSelect: () => window.open(`/help/${helpPath(node.path, node.slug)}`, '_blank', 'noopener') },
                {
                  label: 'Copy link',
                  icon: <CopyIcon size={15} />,
                  onSelect: () => void navigator.clipboard?.writeText(`${location.origin}/help/${helpPath(node.path, node.slug)}`).then(() => shared.onStatus('Link copied.')),
                },
              ]
            : []),
          'separator',
          { label: 'Delete', icon: <TrashIcon size={15} />, destructive: true, onSelect: () => shared.onDelete(item) },
        ]
  const moved = shared.arranging && shared.moved.has(row.key)

  return (
    <>
      <li
        draggable={shared.arranging && !renaming}
        onDragStart={(e) => {
          dragging.current = item
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('text/plain', node.title)
        }}
        onDragEnd={() => {
          dragging.current = null
          onDragEnd()
        }}
        onDragOver={onDragOver}
        onDrop={onDrop}
        className={cn(
          'group relative mx-1.5 flex items-center gap-2 rounded-lg py-1.5 pr-1.5 hover:bg-muted/60',
          shared.arranging && 'cursor-grab active:cursor-grabbing',
          moved && 'bg-primary/5',
          drop?.at === 'into' && (drop.problem ? 'bg-destructive/5' : 'bg-primary/5 ring-2 ring-primary ring-inset'),
        )}
        style={indent}
      >
        {/* Drop line above or below, at this row's indent. */}
        {drop && drop.at !== 'into' && (
          <span
            aria-hidden="true"
            className={cn('pointer-events-none absolute right-2 h-0.5 rounded-full', drop.problem ? 'bg-destructive' : 'bg-primary', drop.at === 'before' ? '-top-px' : '-bottom-px')}
            style={{ left: indent.paddingLeft }}
          />
        )}
        {shared.arranging && <GripIcon size={14} className="absolute left-1 shrink-0 text-muted-foreground opacity-50 group-hover:opacity-100" aria-hidden="true" />}

        {isFolder ? (
          <Tooltip content={open ? 'Collapse' : 'Expand'}>
            <button
              type="button"
              onClick={() => shared.toggle(row.key)}
              aria-expanded={open}
              aria-label={`${open ? 'Close' : 'Open'} ${node.title}`}
              className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground hover:text-foreground"
            >
              <ChevronRightIcon size={14} className={cn(open && 'rotate-90')} />
            </button>
          </Tooltip>
        ) : (
          <span className="size-6 shrink-0" aria-hidden="true" />
        )}
        {isFolder ? <FolderIcon size={16} className="shrink-0 text-muted-foreground" /> : <FileIcon size={16} className="shrink-0 text-muted-foreground" />}

        <div className="min-w-0 flex-1">
          {renaming && isFolder ? (
            <InlineName
              initial={node.title}
              label="Folder name"
              onDone={(title) => {
                shared.setEditing(null)
                if (title && title !== node.title) shared.onRename(visibility, node.path, title)
              }}
            />
          ) : isFolder ? (
            <button type="button" onClick={() => shared.toggle(row.key)} className="flex w-full min-w-0 items-baseline gap-2 text-left">
              <span className="truncate text-sm font-medium">{node.title}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{countFiles(node)}</span>
            </button>
          ) : shared.arranging ? (
            <span className="flex w-full min-w-0 items-baseline gap-2">
              <span className="truncate text-sm">{node.title}</span>
              <span className="hidden shrink-0 font-mono text-xs text-muted-foreground sm:inline">{node.name}</span>
            </span>
          ) : (
            <Link to="/dashboard/editor" search={editorSearch} className="flex w-full min-w-0 items-baseline gap-2" draggable={false}>
              <span className="truncate text-sm underline-offset-4 group-hover:underline">{node.title}</span>
              <span className="hidden shrink-0 font-mono text-xs text-muted-foreground sm:inline">{node.name}</span>
            </Link>
          )}
        </div>

        {moved && <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">Moved</span>}
        {node.kind === 'file' && node.draft && (
          <Tooltip content={visibility === 'public' ? 'Not in the help center, and the AI doesn’t use it' : 'The AI doesn’t use it'}>
            <span tabIndex={0} className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
              Draft
            </span>
          </Tooltip>
        )}
        {node.kind === 'file' && !shared.arranging && (
          <span className="hidden shrink-0 text-xs text-muted-foreground md:inline">
            <RelativeTime iso={node.modifiedAt} />
          </span>
        )}
        <ActionsMenu label={`Actions for ${node.title}`} items={menu} />
      </li>
      {newFolderInside && <NewFolderRow depth={depth + 1} shared={shared} visibility={visibility} parent={node.path} />}
    </>
  )
}

function NewFolderRow({ depth, shared, visibility, parent }: { depth: number; shared: TreeShared; visibility: Visibility; parent: string }) {
  return (
    <li className="mx-1.5 flex items-center gap-2 rounded-lg py-1.5 pr-1.5" style={{ paddingLeft: `${0.75 + depth * 1.5}rem` }}>
      <span className="size-6 shrink-0" aria-hidden="true" />
      <FolderIcon size={16} className="shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <InlineName
          initial=""
          label="New folder name"
          placeholder={visibility === 'public' ? 'Section name, e.g. Billing' : 'Folder name'}
          onDone={(title) => {
            shared.setEditing(null)
            if (title) shared.onCreateFolder(visibility, parent, title)
          }}
        />
      </div>
    </li>
  )
}

// A name typed in place: Enter saves, Escape (or leaving the field empty) cancels.
function InlineName({ initial, label, placeholder, onDone }: { initial: string; label: string; placeholder?: string; onDone: (value: string | null) => void }) {
  const [value, setValue] = useState(initial)
  const done = useRef(false)
  const finish = (v: string | null) => {
    if (done.current) return
    done.current = true
    onDone(v?.trim() ? v.trim().slice(0, 60) : null)
  }
  return (
    <input
      autoFocus
      aria-label={label}
      value={value}
      placeholder={placeholder}
      maxLength={60}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(value)
        if (e.key === 'Escape') finish(null)
      }}
      onBlur={() => finish(value)}
      className="h-7 w-full max-w-xs rounded-md border border-ring bg-background px-2 text-sm outline-none"
    />
  )
}
