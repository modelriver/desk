import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { createFileRoute, Link, redirect, useBlocker, useNavigate, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import {
  checkFolderUpload,
  createDataFolder,
  deleteDataItem,
  getDataTree,
  moveDataItem,
  renameDataFolder,
  setArticleStatus,
  setArticlesStatus,
  setDataFolderDetails,
  uploadFile,
  uploadFolderBatch,
} from '../../functions/data.ts'
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronRightIcon,
  CopyIcon,
  ExternalIcon,
  EyeIcon,
  EyeOffIcon,
  FileIcon,
  FilePlusIcon,
  FolderIcon,
  FolderPlusIcon,
  FolderUploadIcon,
  GripIcon,
  LockIcon,
  LogOutIcon,
  MoveIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  SendIcon,
  TrashIcon,
  UndoIcon,
  UploadIcon,
  XIcon,
} from '../../components/icons.tsx'
import { ActionsMenu, type MenuItem } from '../../components/ActionsMenu.tsx'
import { FilePreview } from '../../components/FilePreview.tsx'
import { ConfirmDialog, FolderDetailsDialog, MoveDialog, type FolderChoice } from '../../components/DataDialogs.tsx'
import { CollectionIcon } from '../../components/CollectionIcon.tsx'
import { LoadError } from '../../components/LoadError.tsx'
import { RelativeTime } from '../../components/RelativeTime.tsx'
import { Button, Checkbox, PageHeader } from '../../components/ui.tsx'
import { shortcutLabel, Tooltip } from '../../components/Tooltip.tsx'
import { cn } from '../../lib/cn.ts'
import { Segmented } from '../../components/Segmented.tsx'
import { applyMove, type Move } from '../../lib/tree-edit.ts'
import { articleUrl, helpPath } from '../../lib/help-path.ts'
import { BusyIcon } from '../../components/BusyIcon.tsx'
import { errorMessage } from '../../lib/errors.ts'
import { describeProblems, describeSkipped, foldersFor, packBatches, type UploadPlan } from '../../lib/folder-upload.ts'
import { droppedEntries, pickedFolder, readDropped, type PickedFile } from '../../lib/dropped-files.ts'
import { draftKeys, filesIn, folderState, matchesFilter, selectedFiles, selectionKey, toggleKeys } from '../../lib/selection.ts'

// The knowledge base: everything the help center and the AI answer from, as
// two trees (Public = help-center articles, Private = internal notes). Folders
// in Public are help-center sections. Drag to arrange; every drag has a menu
// equivalent (Move to…, Move up/down) for keyboards and touch screens.

export const Route = createFileRoute('/dashboard/data')({
  head: () => ({ meta: [{ title: 'Knowledge · Dashboard' }] }),
  beforeLoad: ({ context }) => {
    if (context.user.role !== 'admin') throw redirect({ to: '/dashboard' })
  },
  loader: () => getDataTree(),
  errorComponent: ({ error }) => (
    <>
      <PageHeader title="Knowledge" />
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
// Rows: each level of folders indents this much, so a child's icon sits under
// its parent's title. TREE_START is where the tree starts in a row (after the
// checkbox column): the top level's chevrons, the drop line and the guides.
const INDENT_REM = 1.375
const TREE_START = '2.125rem'
const ROOTS: Record<Visibility, { title: string; detail: string; newLabel: string }> = {
  public: {
    title: 'Public',
    detail: 'On the help center, and cited by the AI. Folders are sections.',
    newLabel: 'New article',
  },
  private: {
    title: 'Private',
    detail: 'Only the AI reads these. Never shown, quoted or linked.',
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
// What a help-center card counts: published articles, subfolders included.
const publishedIn = (f: Folder): number => f.children.reduce((n, c) => n + (c.kind === 'file' ? Number(!c.draft && c.name.endsWith('.md')) : publishedIn(c)), 0)
// "articles" when they're all public, "notes" when all private, "files" when mixed.
const nounFor = (files: Array<{ visibility: Visibility }>, n = files.length) => {
  const kind = files.every((f) => f.visibility === 'public') ? 'article' : files.every((f) => f.visibility === 'private') ? 'note' : 'file'
  return n === 1 ? kind : `${kind}s`
}
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
  const checkUpload = useServerFn(checkFolderUpload)
  const uploadBatch = useServerFn(uploadFolderBatch)
  const setStatus$ = useServerFn(setArticleStatus)
  const setStatuses = useServerFn(setArticlesStatus)
  const saveDetails = useServerFn(setDataFolderDetails)

  const { collapsed, toggle } = useCollapsed()
  // Files ticked to publish or unpublish together, by selectionKey. Uploads
  // select their new drafts, so publishing them is one click away.
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  // Everything, or only drafts (to review and publish them).
  const [show, setShow] = useState<'all' | 'drafts'>('all')
  const [bulk, setBulk] = useState<'published' | 'draft' | null>(null)
  // A public folder's card (description and icon) being edited.
  const [details, setDetails] = useState<Folder | null>(null)
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
  // A checked folder upload that would replace existing files, waiting for a yes.
  const [replacing, setReplacing] = useState<{ files: PickedFile[]; visibility: Visibility; folder: string; plan: UploadPlan } | null>(null)
  const [arrangement, setArrangement] = useState<Arrangement | null>(null)
  const [discarding, setDiscarding] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const folderInput = useRef<HTMLInputElement>(null)

  const arranging = arrangement !== null
  const changes = arrangement?.moves.length ?? 0
  // What's on screen: the saved tree, or the arrangement being made.
  const view = arrangement?.draft ?? data
  // What's selected and still there, in tree order.
  const selection = useMemo(() => selectedFiles(data, selected), [data, selected])
  const selectedDrafts = selection.filter((f) => f.draft)
  const selectedLive = selection.filter((f) => !f.draft)
  // What the confirmation acts on, and the rest of the selection it leaves alone.
  const bulkFiles = bulk === 'published' ? selectedDrafts : selectedLive
  const bulkOthers = bulk === 'published' ? selectedLive.length : selectedDrafts.length
  const allDrafts = useMemo(() => draftKeys(data, filter.trim().toLowerCase()), [data, filter])
  const selectKeys = (keys: string[]) => setSelected((s) => toggleKeys(s, keys))
  const clearSelection = () => setSelected(new Set())

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
    setShow('all')
    setEditing(null)
    setStatus(null)
    clearSelection()
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

  // Escape clears a selection (outside fields and dialogs, which use it themselves).
  const hasSelection = selection.length > 0
  useEffect(() => {
    if (!hasSelection || arranging) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || (e.target instanceof HTMLElement && e.target.closest('input:not([type=checkbox]), textarea, dialog, [role=menu]'))) return
      setSelected(new Set())
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [hasSelection, arranging])

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
      const drafts: string[] = []
      for (const file of list) {
        const form = new FormData()
        form.set('visibility', visibility)
        form.set('folder', folder)
        form.set('file', file)
        const result = await upload({ data: form })
        if (result.draft) drafts.push(selectionKey(visibility, result.path))
      }
      selectUploaded(drafts)
      return { text: uploadedMessage(list.length === 1 ? list[0]!.name : `${list.length} files`, list.length, drafts.length) }
    })
  }

  // Publish the selected drafts, or Unpublish the selected live files, after the confirmation.
  const applyBulk = (status: 'published' | 'draft') => {
    const files = status === 'published' ? selectedDrafts : selectedLive
    void run(async () => {
      const { changed } = await setStatuses({ data: { items: files.map(({ visibility, path }) => ({ visibility, path })), status } })
      setBulk(null)
      clearSelection()
      const noun = nounFor(files, changed)
      return { text: status === 'published' ? `Published ${changed} ${noun}.` : `Unpublished ${changed} ${noun}. ${changed === 1 ? 'It’s a draft' : 'They’re drafts'} now.` }
    })
  }

  // New uploads are drafts: select them, so publishing is one click away.
  const selectUploaded = (keys: string[]) => {
    if (keys.length) setSelected((s) => new Set([...s, ...keys]))
  }
  const uploadedMessage = (what: string, total: number, drafts: number, extra = '') => {
    if (!drafts) return `Uploaded ${what}.${extra}`
    const which = drafts < total ? `${drafts} of them are drafts` : total === 1 ? 'It’s a draft' : 'They’re drafts'
    return `Uploaded ${what}.${extra} ${which}, selected and ready to publish.`
  }

  // A whole folder: checked on the server first, so nothing is written if any
  // of it can't go in; then sent in batches small enough for the proxy.
  const uploadFolder = (read: () => Promise<PickedFile[]>, visibility: Visibility, folder: string) => {
    void run(async () => {
      const files = await read()
      if (!files.length) return { text: 'That folder is empty.' }
      const check = await checkUpload({ data: { visibility, folder, entries: files.map((f) => ({ path: f.path, size: f.file.size })) } })
      if (!check.ok) throw new Error(describeProblems(check.problems))
      if (check.plan.files.some((f) => f.replaces)) {
        setReplacing({ files, visibility, folder, plan: check.plan })
        return
      }
      return sendFolder(files, visibility, folder, check.plan)
    })
  }

  const sendFolder = async (files: PickedFile[], visibility: Visibility, folder: string, plan: UploadPlan) => {
    const bySource = new Map(files.map((f) => [f.path, f.file]))
    const titles = Object.fromEntries(plan.folders.map((f) => [f.path, f.title]))
    const items = plan.files.map((f) => ({ path: f.path, file: bySource.get(f.source)!, size: bySource.get(f.source)!.size }))
    const total = items.length
    const drafts: string[] = []
    let done = 0
    try {
      for (const batch of packBatches(items)) {
        const form = new FormData()
        form.set('visibility', visibility)
        form.set('titles', JSON.stringify(Object.fromEntries(foldersFor(batch.map((i) => i.path), titles).map((f) => [f.path, f.title]))))
        for (const item of batch) {
          form.append('path', item.path)
          form.append('file', item.file)
        }
        const { files: written } = await uploadBatch({ data: form })
        for (const f of written) if (f.draft) drafts.push(selectionKey(visibility, f.path))
        done += batch.length
        if (done < total) setStatus({ ok: true, text: `Uploading… ${done} of ${total} files.` })
      }
    } catch (err) {
      const reason = errorMessage(err, 'Something went wrong.')
      throw new Error(done ? `Uploaded ${done} of ${total} files, then stopped: ${reason}` : reason)
    } finally {
      // Whatever made it in is selected, even when a later batch failed.
      selectUploaded(drafts)
    }
    toggle(keyOf(visibility, folder), true)
    for (const f of plan.folders) toggle(keyOf(visibility, f.path), true)
    const made = plan.folders.length ? ` and made ${plan.folders.length} folder${plan.folders.length === 1 ? '' : 's'}` : ''
    const skipped = describeSkipped(plan.skipped, visibility)
    return { text: uploadedMessage(`${total} file${total === 1 ? '' : 's'}${made}`, total, drafts.length, skipped ? ` ${skipped}` : '') }
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
    draftsOnly: show === 'drafts',
    busy,
    editing,
    setEditing,
    onMove: moveItem,
    onUpload: uploadFiles,
    onUploadFolder: uploadFolder,
    selected,
    selecting: hasSelection,
    onSelect: selectKeys,
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
    onEditDetails: setDetails,
    onPreview: (item) => setPreviewing({ visibility: item.visibility, path: item.path, name: item.name }),
    onSetStatus: (item, status, title) => setStatusChange({ item, status, title }),
    onAskUpload: (visibility, folder) => {
      setUploadTarget({ visibility, folder })
      fileInput.current?.click()
    },
    onAskUploadFolder: (visibility, folder) => {
      setUploadTarget({ visibility, folder })
      folderInput.current?.click()
    },
    onNewArticle: (visibility, folder) => void navigate({ to: '/dashboard/editor', search: { visibility, folder } }),
    onStatus: (text) => setStatus({ ok: true, text }),
    onProblem: (text) => setStatus({ ok: false, text }),
  }

  return (
    <>
      <PageHeader
        title="Knowledge"
        description="Help-center articles, and private notes only the AI reads. Drafts stay hidden until you publish them."
        actions={
          arranging ? undefined : (
            <>
              <Tooltip content="Reorder, or move things between folders">
                <Button variant="ghost" onClick={startArranging}>
                  <MoveIcon size={15} />
                  Arrange
                </Button>
              </Tooltip>
              <ActionsMenu
                label="Add"
                button={{
                  variant: 'default',
                  content: (
                    <>
                      <PlusIcon size={15} />
                      Add
                    </>
                  ),
                }}
                items={[
                  { label: 'Write an article', icon: <FilePlusIcon size={15} />, onSelect: () => shared.onNewArticle('public', '') },
                  { label: 'Write an internal note', icon: <LockIcon size={15} />, onSelect: () => shared.onNewArticle('private', '') },
                  { label: 'New section folder', icon: <FolderPlusIcon size={15} />, onSelect: () => setEditing({ kind: 'new-folder', visibility: 'public', parent: '' }) },
                  'separator',
                  { label: 'Upload articles', icon: <UploadIcon size={15} />, onSelect: () => shared.onAskUpload('public', '') },
                  { label: 'Upload a folder of articles', icon: <FolderUploadIcon size={15} />, onSelect: () => shared.onAskUploadFolder('public', '') },
                ]}
              />
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
      <input
        ref={folderInput}
        type="file"
        // A folder picker: every file inside, each with its path in the folder.
        {...{ webkitdirectory: '' }}
        className="hidden"
        onChange={(e) => {
          const picked = e.target.files ? [...e.target.files] : []
          if (uploadTarget && picked.length) uploadFolder(async () => pickedFolder(picked), uploadTarget.visibility, uploadTarget.folder)
          e.target.value = ''
        }}
      />

      {arranging ? (
        <div
          role="region"
          aria-label="Arranging"
          data-motion=""
          className="bar-in sticky top-3 z-30 mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-primary/50 bg-card px-4 py-3"
        >
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium">
              Arranging{' '}
              <span className="font-normal text-muted-foreground tabular-nums" aria-live="polite">
                · {changes === 0 ? 'no changes yet' : changes === 1 ? '1 change' : `${changes} changes`}
              </span>
            </p>
            <p className="truncate text-xs text-muted-foreground">Drag to reorder, or use a row’s menu. Nothing goes live until you save.</p>
          </div>
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
        <>
        {hasSelection && (
          <div
            role="region"
            aria-label="Selected files"
            data-motion=""
            className="bar-in sticky top-3 z-30 mb-3 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-primary/50 bg-card px-4 py-3"
          >
            <div className="min-w-0 flex-1" aria-live="polite">
              <p className="text-[13px] font-medium tabular-nums">{selection.length} selected</p>
              <p className="text-xs text-muted-foreground tabular-nums">
                {[selectedDrafts.length && `${selectedDrafts.length} draft${selectedDrafts.length === 1 ? '' : 's'}`, selectedLive.length && `${selectedLive.length} published`]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Tooltip content="Clear the selection" shortcut="Esc">
                <Button variant="ghost" size="sm" onClick={clearSelection} disabled={busy}>
                  Clear
                </Button>
              </Tooltip>
              {selectedLive.length > 0 && (
                <Button variant="outline" size="sm" onClick={() => setBulk('draft')} disabled={busy}>
                  <EyeOffIcon size={14} />
                  Unpublish {selectedLive.length}
                </Button>
              )}
              {selectedDrafts.length > 0 && (
                <Button size="sm" onClick={() => setBulk('published')} disabled={busy}>
                  <BusyIcon busy={busy} size={14} />
                  {!busy && <SendIcon size={14} />}
                  Publish {selectedDrafts.length}
                </Button>
              )}
            </div>
          </div>
        )}
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div className="relative w-full max-w-sm">
            <SearchIcon size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground" />
            <label htmlFor="data-filter" className="sr-only">
              Search files
            </label>
            <input
              id="data-filter"
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Search by title or file name"
              className="h-8 w-full rounded-md border border-input bg-card pr-3 pl-9 text-[13px] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring"
            />
          </div>
          <Segmented
            label="Show"
            size="sm"
            value={show}
            onChange={setShow}
            options={[
              { value: 'all', label: 'All' },
              {
                value: 'drafts',
                label: (
                  <>
                    Drafts
                    {allDrafts.length > 0 && <span className="text-xs font-normal text-muted-foreground tabular-nums">{allDrafts.length}</span>}
                  </>
                ),
              },
            ]}
          />
        </div>
        </>
      )}

      {status && (
        <div
          role={status.ok ? 'status' : 'alert'}
          className={cn(
            'mb-4 flex items-center gap-3 rounded-lg border px-3.5 py-2 text-[13px]',
            !arranging && !hasSelection && 'sticky top-3 z-30',
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

      <div className="grid grid-cols-1 gap-6">
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
        icon={<UndoIcon size={18} />}
        confirmLabel="Discard"
        onClose={() => setDiscarding(false)}
        onConfirm={stopArranging}
      >
        Everything goes back to how it was. Nothing on the help center has changed.
      </ConfirmDialog>
      <ConfirmDialog
        open={blocker.status === 'blocked'}
        title="Leave without saving the new arrangement?"
        icon={<LogOutIcon size={18} />}
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
        icon={statusChange?.status === 'draft' ? <EyeOffIcon size={18} /> : <SendIcon size={18} />}
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
            <span className="font-mono text-xs">{articleUrl(helpPath(statusChange.item.path, statusChange.item.path.slice(statusChange.item.path.lastIndexOf('/') + 1).replace(/\.md$/, '')))}</span>,
            and the AI starts answering from it.
          </>
        ) : (
          'The AI starts answering from it. Private notes are never shown to visitors.'
        )}
      </ConfirmDialog>
      <ConfirmDialog
        open={deleting !== null}
        title={deleting?.kind === 'folder' ? `Delete the folder “${deleting.title}”?` : `Delete “${deleting?.title ?? ''}”?`}
        icon={<TrashIcon size={18} />}
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
      <ConfirmDialog
        open={bulk !== null}
        tone={bulk === 'published' ? 'primary' : 'destructive'}
        busy={busy}
        title={`${bulk === 'published' ? 'Publish' : 'Unpublish'} ${bulkFiles.length} ${nounFor(bulkFiles)}?`}
        icon={bulk === 'published' ? <SendIcon size={18} /> : <EyeOffIcon size={18} />}
        items={bulkFiles.map((f) => f.title)}
        note={bulkOthers > 0 ? `The ${bulkOthers} ${bulk === 'published' ? 'already published' : `draft${bulkOthers === 1 ? '' : 's'}`} in your selection stay${bulkOthers === 1 ? 's' : ''} as ${bulkOthers === 1 ? 'it is' : 'they are'}.` : undefined}
        confirmLabel={bulk === 'published' ? `Publish ${selectedDrafts.length}` : `Unpublish ${selectedLive.length}`}
        onClose={() => setBulk(null)}
        onConfirm={() => bulk && applyBulk(bulk)}
      >
        {(() => {
          const one = bulkFiles.length === 1
          const anyPublic = bulkFiles.some((f) => f.visibility === 'public')
          if (bulk === 'published') {
            return anyPublic
              ? `${one ? 'It goes' : 'They go'} live on the help center, and the AI starts answering from ${one ? 'it' : 'them'}.`
              : `The AI starts answering from ${one ? 'it' : 'them'}.`
          }
          return `${anyPublic ? `${one ? 'It comes' : 'They come'} off the help center, and the AI` : 'The AI'} stops using ${one ? 'it' : 'them'}. ${
            one ? 'It stays here as a draft' : 'They stay here as drafts'
          }, so you can publish ${one ? 'it' : 'them'} again any time.`
        })()}
      </ConfirmDialog>
      <ConfirmDialog
        open={replacing !== null}
        title={(() => {
          const n = replacing?.plan.files.filter((f) => f.replaces).length ?? 0
          return `Replace ${n === 1 ? 'a file that’s' : `${n} files that are`} already here?`
        })()}
        confirmLabel="Upload and replace"
        icon={<UploadIcon size={18} />}
        items={replacing?.plan.files.filter((f) => f.replaces).map((f) => f.path)}
        note="New files in the upload are saved as drafts. This can’t be undone."
        busy={busy}
        onClose={() => setReplacing(null)}
        onConfirm={() => {
          if (!replacing) return
          const { files, visibility, folder, plan } = replacing
          setReplacing(null)
          void run(() => sendFolder(files, visibility, folder, plan))
        }}
      >
        The uploaded files replace these. Each keeps its status, so a published article stays live with the new content.
      </ConfirmDialog>
      <FolderDetailsDialog
        folder={details}
        articles={details ? publishedIn(details) : 0}
        busy={busy}
        onClose={() => setDetails(null)}
        onSave={(next) => {
          if (!details) return
          const folder = details
          void run(async () => {
            await saveDetails({ data: { path: folder.path, ...next } })
            setDetails(null)
            return { text: `Updated the “${folder.title}” card on the help center.` }
          })
        }}
      />
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
  // The Drafts view: only drafts show, and only they can be ticked.
  draftsOnly: boolean
  busy: boolean
  editing: { kind: 'rename'; key: string } | { kind: 'new-folder'; visibility: Visibility; parent: string } | null
  setEditing: (e: TreeShared['editing']) => void
  onMove: (item: Item, to: { visibility: Visibility; folder: string; before: string | null }) => void
  onUpload: (files: FileList, visibility: Visibility, folder: string) => void
  // A folder, with what's inside it; `read` collects the files.
  onUploadFolder: (read: () => Promise<PickedFile[]>, visibility: Visibility, folder: string) => void
  // Files ticked for Publish or Unpublish (selectionKey), and whether any are,
  // which keeps every checkbox showing rather than only on hover.
  selected: ReadonlySet<string>
  selecting: boolean
  // Tick or untick these files: all of them, or none when they're all ticked.
  onSelect: (keys: string[]) => void
  onRename: (visibility: Visibility, path: string, title: string) => void
  onCreateFolder: (visibility: Visibility, parent: string, title: string) => void
  onDelete: (item: Item) => void
  onPickMove: (item: Item) => void
  // A public folder's description and icon, for its help-center card.
  onEditDetails: (folder: Folder) => void
  onPreview: (item: Item) => void
  // Publish a draft, or Unpublish: move a published file back to draft.
  onSetStatus: (item: Item, status: 'published' | 'draft', title: string) => void
  onAskUpload: (visibility: Visibility, folder: string) => void
  onAskUploadFolder: (visibility: Visibility, folder: string) => void
  onNewArticle: (visibility: Visibility, folder: string) => void
  onStatus: (text: string) => void
  onProblem: (text: string) => void
}

// The item being dragged, shared by every row (a drag can cross trees).
const dragging: { current: Item | null } = { current: null }

function Tree({ visibility, root, shared }: { visibility: Visibility; root: Folder; shared: TreeShared }) {
  const { collapsed, filter, draftsOnly } = shared
  const [drop, setDrop] = useState<{ key: string; at: DropAt; problem: string | null } | null>(null)
  const expandTimer = useRef<{ key: string; timer: ReturnType<typeof setTimeout> } | null>(null)
  const meta = ROOTS[visibility]
  const narrowed = filter !== '' || draftsOnly

  // Rows in display order: open folders show their contents. A search or the
  // Drafts view shows matching files with the folders around them, opened.
  const rows = useMemo(() => {
    const out: Row[] = []
    const matches = (n: Node): boolean =>
      n.kind === 'file'
        ? matchesFilter(n, filter, draftsOnly)
        : (!draftsOnly && filter !== '' && n.title.toLowerCase().includes(filter)) || n.children.some(matches)
    const walk = (f: Folder, depth: number) => {
      const visible = narrowed ? f.children.filter(matches) : f.children
      const siblings = f.children.map((c) => c.name)
      visible.forEach((node) => {
        out.push({ key: keyOf(visibility, node.path), visibility, node, depth, parent: f.path, siblings, index: siblings.indexOf(node.name) })
        if (node.kind === 'folder' && (narrowed || !collapsed.has(keyOf(visibility, node.path)))) walk(node, depth + 1)
      })
    }
    walk(root, 0)
    return out
  }, [root, collapsed, filter, draftsOnly, narrowed, visibility])
  // The header's checkbox: everything this section shows.
  const sectionKeys = filesIn(visibility, root, filter, draftsOnly)
  const sectionState = folderState(sectionKeys, shared.selected)

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
      // Read the entries now: the browser empties dataTransfer once this returns.
      const entries = droppedEntries(e.dataTransfer)
      if (entries.some((entry) => entry.isDirectory)) shared.onUploadFolder(() => readDropped(entries), visibility, folder)
      else shared.onUpload(e.dataTransfer.files, visibility, folder)
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
    <section aria-labelledby={`tree-${visibility}`} className="min-w-0 rounded-xl border border-border bg-card">
      <div
        onDragOver={(e) => onDragOver(e, null)}
        onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Element) && clearDrop()}
        onDrop={(e) => onDrop(e, null)}
        className={cn(
          'flex items-center gap-2 rounded-t-xl border-b border-border py-2.5 pr-2 pl-3',
          drop?.key === keyOf(visibility, '') && (drop.problem ? 'bg-destructive/5' : 'bg-primary/5 ring-2 ring-primary ring-inset'),
        )}
      >
        {/* Lined up with the rows' checkbox column. */}
        {!shared.arranging && (
          <label className={cn('grid size-4 shrink-0 place-items-center', sectionKeys.length ? 'cursor-pointer' : 'invisible')}>
            <Checkbox
              checked={sectionState === 'all'}
              indeterminate={sectionState === 'some'}
              disabled={!sectionKeys.length}
              onChange={() => shared.onSelect(sectionKeys)}
              aria-label={`Select ${draftsOnly ? 'every draft' : 'everything'} in ${meta.title}`}
            />
          </label>
        )}
        <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2.5">
          <h2 id={`tree-${visibility}`} className="text-sm font-semibold">
            {meta.title} <span className="font-normal text-muted-foreground tabular-nums">{countFiles(root)}</span>
          </h2>
          <p className="max-w-full min-w-0 truncate text-xs text-muted-foreground">{meta.detail}</p>
        </div>
        {!shared.arranging && (
          <ActionsMenu
            label={`Add to ${meta.title}`}
            items={[
              { label: meta.newLabel, icon: <FilePlusIcon size={15} />, onSelect: () => shared.onNewArticle(visibility, '') },
              { label: 'New folder', icon: <FolderPlusIcon size={15} />, onSelect: () => shared.setEditing({ kind: 'new-folder', visibility, parent: '' }) },
              'separator',
              { label: 'Upload files', icon: <UploadIcon size={15} />, onSelect: () => shared.onAskUpload(visibility, '') },
              { label: 'Upload a folder', icon: <FolderUploadIcon size={15} />, onSelect: () => shared.onAskUploadFolder(visibility, '') },
            ]}
          />
        )}
      </div>

      <ul onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Element) && clearDrop()}>
        {newFolderHere === '' && <NewFolderRow depth={0} shared={shared} visibility={visibility} parent="" />}
        {rows.map((row, i) => (
          <TreeRow
            key={row.key}
            row={row}
            shared={shared}
            drop={drop?.key === row.key ? drop : null}
            onDragOver={(e) => onDragOver(e, row)}
            onDrop={(e) => onDrop(e, row)}
            onDragEnd={clearDrop}
            last={i === rows.length - 1}
            newFolderInside={newFolderHere === row.node.path && row.node.kind === 'folder'}
          />
        ))}
        {rows.length === 0 && newFolderHere === null && (
          <li className="px-4 py-8 text-center text-sm text-muted-foreground">
            {draftsOnly && !filter ? 'No drafts here.' : narrowed ? 'Nothing matches the search.' : visibility === 'public' ? 'No articles yet. Write one, or drop Markdown files or a folder here.' : 'No notes yet. Write one, or drop .md or .txt files or a folder here.'}
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
  last,
  newFolderInside,
}: {
  row: Row
  shared: TreeShared
  drop: { at: DropAt; problem: string | null } | null
  onDragOver: (e: DragEvent) => void
  onDrop: (e: DragEvent) => void
  onDragEnd: () => void
  // The section's last row: no line under it, the box's border closes it.
  last: boolean
  newFolderInside: boolean
}) {
  const { node, visibility, depth } = row
  const navigate = useNavigate()
  const item = itemOf(visibility, node)
  const isFolder = node.kind === 'folder'
  const open = isFolder && (shared.filter !== '' || shared.draftsOnly || !shared.collapsed.has(row.key))
  const renaming = shared.editing?.kind === 'rename' && shared.editing.key === row.key
  // The checkbox column stays put; only the tree part is indented, a step per level.
  const indent = `${depth * INDENT_REM}rem`
  const editorSearch = { visibility, path: node.path }

  // The Markdown files this row selects (its checkbox, or a folder's menu): the file itself, or everything the filter shows in the folder.
  const selectKeys = isFolder ? filesIn(visibility, node, shared.filter, shared.draftsOnly) : node.name.endsWith('.md') ? [selectionKey(visibility, node.path)] : []
  const selectState = folderState(selectKeys, shared.selected)

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
          ...(depth + 1 < MAX_DEPTH
            ? [{ label: 'Upload a folder here', icon: <FolderUploadIcon size={15} />, onSelect: () => shared.onAskUploadFolder(visibility, node.path) }]
            : []),
          'separator',
          { label: 'Rename', icon: <PencilIcon size={15} />, onSelect: () => shared.setEditing({ kind: 'rename', key: row.key }) },
          // Public folders are help-center sections, with a card of their own.
          ...(visibility === 'public' && node.kind === 'folder'
            ? [{ label: 'Icon & description…', icon: <CollectionIcon icon={node.icon} size={15} />, onSelect: () => shared.onEditDetails(node) }]
            : []),
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
                { label: 'Open in help center', icon: <ExternalIcon size={15} />, onSelect: () => window.open(articleUrl(helpPath(node.path, node.slug)), '_blank', 'noopener') },
                {
                  label: 'Copy link',
                  icon: <CopyIcon size={15} />,
                  onSelect: () => void navigator.clipboard?.writeText(`${location.origin}${articleUrl(helpPath(node.path, node.slug))}`).then(() => shared.onStatus('Link copied.')),
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
          'group relative flex items-center gap-1.5 py-1 pr-2 pl-3 last:rounded-b-xl',
          shared.arranging && 'cursor-grab active:cursor-grabbing',
          (moved || (!isFolder && selectState === 'all')) && 'bg-primary/5',
          drop?.at === 'into' && (drop.problem ? 'bg-destructive/5' : 'bg-primary/5 ring-2 ring-primary ring-inset'),
        )}
      >
        {/* Where this row sits in the tree: a faint line under each folder it's
            in. The line between rows starts at the row's icon, so it nests with
            the tree instead of crossing these. */}
        {Array.from({ length: depth }, (_, level) => (
          <span
            key={level}
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 w-px bg-border/70"
            style={{ left: `calc(${TREE_START} + ${level * INDENT_REM}rem + 0.5rem)` }}
          />
        ))}
        {!last && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute right-0 bottom-0 h-px bg-border/50"
            style={{ left: `calc(${TREE_START} + ${indent} + 1.375rem)` }}
          />
        )}
        {/* Drop line above or below, at this row's indent. */}
        {drop && drop.at !== 'into' && (
          <span
            aria-hidden="true"
            className={cn('pointer-events-none absolute right-2 h-0.5 rounded-full', drop.problem ? 'bg-destructive' : 'bg-primary', drop.at === 'before' ? '-top-px' : '-bottom-px')}
            style={{ left: `calc(${TREE_START} + ${indent})` }}
          />
        )}
        {/* Selecting: a narrow column of checkboxes, files and folders alike
            (a folder's ticks everything in it). They show on hover, and on
            every row while anything is selected; while arranging, the drag
            handle shows there instead. */}
        <span className="grid size-4 shrink-0 place-items-center">
          {shared.arranging ? (
            <GripIcon size={14} aria-hidden="true" className="text-muted-foreground opacity-0 group-hover:opacity-100" />
          ) : selectKeys.length ? (
            <label
              className={cn(
                'grid cursor-pointer place-items-center',
                shared.selecting || selectState !== 'none'
                  ? 'opacity-100'
                  : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100',
              )}
            >
              <Checkbox
                checked={selectState === 'all'}
                indeterminate={selectState === 'some'}
                onChange={() => shared.onSelect(selectKeys)}
                aria-label={isFolder ? `Select everything in ${node.title}` : `Select ${node.title}`}
              />
            </label>
          ) : null}
        </span>

        {/* The tree: a folder's chevron (empty for files, so icons line up), then the icon. */}
        <span className="grid size-4 shrink-0 place-items-center" style={{ marginLeft: indent }}>
          {isFolder && (
            <Tooltip content={open ? 'Collapse' : 'Expand'}>
              <button
                type="button"
                onClick={() => shared.toggle(row.key)}
                aria-expanded={open}
                aria-label={`${open ? 'Close' : 'Open'} ${node.title}`}
                className="grid size-4 shrink-0 place-items-center rounded text-muted-foreground outline-none hover:text-foreground focus-visible:bg-muted focus-visible:text-foreground"
              >
                <ChevronRightIcon size={13} className={cn(open && 'rotate-90')} />
              </button>
            </Tooltip>
          )}
        </span>
        <span className="grid size-4 shrink-0 place-items-center text-muted-foreground" aria-hidden="true">
          {isFolder ? node.icon ? <CollectionIcon icon={node.icon} size={16} /> : <FolderIcon size={16} /> : <FileIcon size={16} />}
        </span>

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
            <span className="block w-full min-w-0 truncate text-sm" title={node.name}>
              {node.title}
            </span>
          ) : (
            <Link to="/dashboard/editor" search={editorSearch} title={node.name} className="block w-full min-w-0 truncate text-sm underline-offset-4 hover:underline" draggable={false}>
              {node.title}
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
    <li className="flex items-center gap-1.5 py-1 pr-2 pl-3">
      <span className="size-4 shrink-0" aria-hidden="true" />
      <span className="size-4 shrink-0" style={{ marginLeft: `${depth * INDENT_REM}rem` }} aria-hidden="true" />
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
