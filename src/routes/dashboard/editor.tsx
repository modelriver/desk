import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode, type RefObject } from 'react'
import { createFileRoute, Link, redirect, useBlocker, useNavigate, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react'
import { BubbleMenu, FloatingMenu } from '@tiptap/react/menus'
import { NodeSelection, TextSelection } from '@tiptap/pm/state'
import { Placeholder } from '@tiptap/extensions'
import { getArticleSource, saveArticleSource } from '../../functions/data.ts'
import { uploadImage } from '../../functions/media.ts'
import { articleExtensions, isImageUrl, normalizeHref } from '../../lib/editor-extensions.ts'
import { rendersSame } from '../../lib/markdown.ts'
import { ACCEPTED_IMAGES, imageFiles, pastedFromWeb, prepareImage, webImageSrc } from '../../lib/image-prepare.ts'
import { wordCount, type ArticleStatus } from '../../lib/article-file.ts'
import { articleUrl, helpPath } from '../../lib/help-path.ts'
import {
  ArrowLeftIcon,
  BoldIcon,
  CheckIcon,
  CodeBlockIcon,
  CodeIcon,
  ExternalIcon,
  EyeOffIcon,
  ImageIcon,
  ItalicIcon,
  LinkIcon,
  ListIcon,
  ListOrderedIcon,
  LogOutIcon,
  MinusIcon,
  PlusIcon,
  QuoteIcon,
  SendIcon,
  SpinnerIcon,
  StrikeIcon,
  TableIcon,
  TrashIcon,
  UploadIcon,
} from '../../components/icons.tsx'
import { ConfirmDialog, ConflictDialog } from '../../components/DataDialogs.tsx'
import { LoadError } from '../../components/LoadError.tsx'
import { RelativeTime } from '../../components/RelativeTime.tsx'
import { Badge, Button, buttonClass, PageHeader } from '../../components/ui.tsx'
import { cn } from '../../lib/cn.ts'
import { Segmented } from '../../components/Segmented.tsx'
import { BusyIcon, useDelayedBusy } from '../../components/BusyIcon.tsx'
import { errorMessage } from '../../lib/errors.ts'

// Writing an article: title, summary and body, edited the way it will look on
// the help center. Markdown shortcuts format as you type (## heading, - list,
// > quote, **bold**); selecting text shows a formatting bar; an empty line
// shows + for blocks. An article is a draft or published: Save draft keeps it
// out of the help center and the AI's answers, Publish puts it there, and
// Unpublish moves a published one back to draft; both ask first, since they
// change what visitors and the AI see. ⌘S saves without changing which it is
// (a new article becomes a draft; a published one asks before publishing). Unsaved changes are backed up
// in this browser until then.

type Visibility = 'public' | 'private'
interface Search {
  visibility: Visibility
  path?: string
  folder?: string
}

export const Route = createFileRoute('/dashboard/editor')({
  validateSearch: (s: Record<string, unknown>): Search => ({
    visibility: s.visibility === 'private' ? 'private' : 'public',
    ...(typeof s.path === 'string' && s.path ? { path: s.path } : {}),
    ...(typeof s.folder === 'string' && s.folder ? { folder: s.folder } : {}),
  }),
  beforeLoad: ({ context }) => {
    if (context.user.role !== 'admin') throw redirect({ to: '/dashboard' })
  },
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => getArticleSource({ data: deps }),
  head: ({ loaderData: a }) => ({
    meta: [{ title: a?.path ? `Edit “${a.title || 'Untitled'}”` : a?.visibility === 'private' ? 'New note' : 'New article' }],
  }),
  errorComponent: ({ error }) => (
    <>
      <PageHeader
        title="Editor"
        actions={
          <Link to="/dashboard/data" className={buttonClass('outline', 'sm')}>
            Back to Knowledge
          </Link>
        }
      />
      <LoadError title="Couldn’t open this article" error={error} />
    </>
  ),
  component: EditorPage,
})

type Article = Awaited<ReturnType<typeof getArticleSource>>
interface Fields {
  title: string
  description: string
  body: string
}
interface Backup extends Fields {
  at: string
}

const changed = (a: Fields, b: Fields, plain: boolean) =>
  a.title !== b.title || a.description !== b.description || (plain ? a.body !== b.body : !rendersSame(a.body, b.body))

function EditorPage() {
  const article = Route.useLoaderData()
  const router = useRouter()
  // A new article keeps its editor when its first save gives it a path: the
  // URL changes, but it's the same piece of writing.
  const aliases = useRef(new Map<string, string>())
  const [generation, setGeneration] = useState(0)
  const id = `${article.visibility}:${article.path ?? `new:${article.folder}`}`
  const key = aliases.current.get(id) ?? id
  return (
    <ArticleEditor
      key={`${key}#${generation}`}
      article={article}
      onCreated={(path) => aliases.current.set(`${article.visibility}:${path}`, key)}
      onReload={async () => {
        await router.invalidate()
        setGeneration((g) => g + 1)
      }}
    />
  )
}

function backupKey(visibility: Visibility, path: string | null, folder: string) {
  return `desk-draft:${visibility}:${path ?? `new:${folder}`}`
}

function readBackup(key: string): Backup | null {
  try {
    const d = JSON.parse(localStorage.getItem(key) ?? 'null') as Backup | null
    return d && typeof d.body === 'string' && typeof d.title === 'string' ? d : null
  } catch {
    return null
  }
}

function ArticleEditor({ article, onCreated, onReload }: { article: Article; onCreated: (path: string) => void; onReload: () => Promise<void> }) {
  const save$ = useServerFn(saveArticleSource)
  const upload$ = useServerFn(uploadImage)
  const navigate = useNavigate()
  const plain = article.format === 'text'
  const isPublic = article.visibility === 'public'
  const fileName = (article.path ?? '').slice((article.path ?? '').lastIndexOf('/') + 1)

  const [path, setPath] = useState(article.path)
  const [base, setBase] = useState(article.modifiedAt)
  const [title, setTitle] = useState(article.title)
  const [description, setDescription] = useState(article.description)
  const [body, setBody] = useState(article.body)
  const [saved, setSaved] = useState<Fields>({ title: article.title, description: article.description, body: article.body })
  const [mode, setMode] = useState<'write' | 'markdown'>(plain ? 'markdown' : 'write')
  // Bumped to re-create the visual editor from `body` (after a restore).
  const [richKey, setRichKey] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)
  // Published: on the help center (public) and used by the AI. Otherwise a
  // draft, which a new article is until its first Publish.
  const [published, setPublished] = useState(article.status === 'published' && article.path !== null)
  const [status, setStatus] = useState<{ kind: 'idle' | 'saving' | 'saved' | 'error'; message?: string; as?: ArticleStatus }>({ kind: 'idle' })
  const [conflict, setConflict] = useState(false)
  // When the other version was saved, for the conflict dialog.
  const [theirsAt, setTheirsAt] = useState<string | null>(null)
  const [backup, setBackup] = useState<Backup | null>(null)
  const [titleError, setTitleError] = useState(false)
  // Images being prepared and uploaded.
  const [uploading, setUploading] = useState(0)

  const titleRef = useRef<HTMLTextAreaElement>(null)
  const descriptionRef = useRef<HTMLTextAreaElement>(null)
  const bodyRef = useRef<HTMLTextAreaElement>(null)
  const rich = useRef<RichApi | null>(null)
  const opened = useRef(false)
  const leaving = useRef(false)

  // The latest fields, read fresh from the visual editor when it's showing.
  const live = (): Fields => ({ title, description, body: mode === 'write' && rich.current ? rich.current.getMarkdown() : body })
  const liveRef = useRef(live)
  liveRef.current = live
  const savedRef = useRef(saved)
  savedRef.current = saved

  const dirty = useMemo(() => changed({ title, description, body }, saved, plain), [title, description, body, saved, plain])
  const words = useMemo(() => wordCount(body), [body])
  const key = backupKey(article.visibility, path, article.folder)

  // A backup left from last time, offered back if it differs from the file.
  useEffect(() => {
    const d = readBackup(key)
    if (d && changed(d, saved, plain)) setBackup(d)
    else if (d) localStorage.removeItem(key)
    // Once, when the article opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Keep a backup in this browser while there are unsaved changes.
  useEffect(() => {
    if (backup) return // Don't overwrite the one being offered.
    const t = setTimeout(() => {
      try {
        if (dirty) localStorage.setItem(key, JSON.stringify({ title, description, body, at: new Date().toISOString() } satisfies Backup))
        else localStorage.removeItem(key)
      } catch {
        // Storage full or blocked: the editor still works, without the backup.
      }
    }, 500)
    return () => clearTimeout(t)
  }, [dirty, title, description, body, key, backup])

  // Saves the article as a draft or published. Plain-text notes have no drafts.
  const lastTarget = useRef<ArticleStatus>('draft')
  const save = async (target: ArticleStatus, overwrite = false) => {
    if (status.kind === 'saving') return
    if (plain) target = 'published'
    lastTarget.current = target
    const fields = liveRef.current()
    if (!plain && !fields.title.trim()) {
      setTitleError(true)
      titleRef.current?.focus()
      return
    }
    setStatus({ kind: 'saving', as: target })
    try {
      const res = await save$({
        data: {
          visibility: article.visibility,
          folder: article.folder,
          path,
          baseModifiedAt: overwrite ? null : base,
          title: plain ? fileName : fields.title.trim(),
          description: fields.description.trim(),
          body: fields.body,
          status: target,
        },
      })
      if (!res.ok) {
        setTheirsAt(res.theirsAt)
        setConflict(true)
        setStatus({ kind: 'idle' })
        return
      }
      setConflict(false)
      setBase(res.modifiedAt)
      setBody(fields.body)
      setSaved(fields)
      setBackup(null)
      try {
        localStorage.removeItem(key)
      } catch {
        // Nothing to clean up.
      }
      setPublished(target === 'published')
      setStatus({ kind: 'saved', as: target })
      if (!path) {
        setPath(res.path)
        onCreated(res.path)
        leaving.current = true
        await navigate({ to: '/dashboard/editor', search: { visibility: article.visibility, path: res.path }, replace: true })
        leaving.current = false
      }
    } catch (err) {
      setStatus({ kind: 'error', message: errorMessage(err, 'Couldn’t save. Try again.') })
    }
  }
  // Publish and Unpublish ask first. The title is checked before asking.
  const [confirming, setConfirming] = useState<ArticleStatus | null>(null)
  const ask = (target: ArticleStatus) => {
    if (!plain && !liveRef.current().title.trim()) {
      setTitleError(true)
      titleRef.current?.focus()
      return
    }
    setConfirming(target)
  }
  const saveRef = useRef(save)
  saveRef.current = save
  const askRef = useRef(ask)
  askRef.current = ask
  const currentTarget = useRef<ArticleStatus>('draft')
  currentTarget.current = published ? 'published' : 'draft'
  const plainRef = useRef(plain)
  plainRef.current = plain

  // ⌘S / Ctrl+S anywhere on the page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 's') {
        e.preventDefault()
        // Saves as it is: a draft stays a draft; a published article asks
        // before its changes go live. Plain-text notes just save.
        if (currentTarget.current === 'published' && !plainRef.current) askRef.current('published')
        else void saveRef.current(currentTarget.current)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Leaving with unsaved changes asks first (in the app, and on closing the tab).
  const hasChanges = () => changed(liveRef.current(), savedRef.current, plain)
  const blocker = useBlocker({
    shouldBlockFn: () => !leaving.current && hasChanges(),
    enableBeforeUnload: hasChanges,
    withResolver: true,
  })

  const toMarkdown = () => {
    if (rich.current) setBody(rich.current.getMarkdown())
    setMode('markdown')
    setNotice(null)
  }
  const toWrite = () => {
    setNotice(null)
    setMode('write')
  }
  // The visual editor would change how the article looks: keep it in Markdown.
  const onLossy = useCallback(() => {
    setMode('markdown')
    setNotice(
      opened.current
        ? 'Some of this Markdown can’t be shown in the visual editor exactly, so it stays in Markdown.'
        : 'This article uses Markdown the visual editor can’t show exactly (like task lists or HTML entities), so it’s open as Markdown. Nothing has been changed.',
    )
  }, [])
  useEffect(() => {
    opened.current = true
  }, [])

  // Pasted, dropped or picked images: shrunk here, stored, and their addresses
  // returned in order. Any that fail are explained in the notice.
  const uploadImages = useCallback(
    async (files: File[]): Promise<string[]> => {
      setUploading((n) => n + files.length)
      const urls: string[] = []
      const problems: string[] = []
      for (const file of files) {
        try {
          const form = new FormData()
          form.append('file', await prepareImage(file), file.name || 'image')
          urls.push((await upload$({ data: form })).url)
        } catch (err) {
          problems.push(files.length > 1 && file.name ? `${file.name}: ${errorMessage(err)}` : errorMessage(err))
        } finally {
          setUploading((n) => n - 1)
        }
      }
      if (problems.length) setNotice(`Couldn’t upload ${problems.length === 1 ? 'the image' : `${problems.length} images`}. ${problems.join(' ')}`)
      return urls
    },
    [upload$],
  )

  // Markdown mode: the uploaded images go where the cursor is, each on its own line.
  const insertMarkdownImages = async (files: File[]) => insertMarkdown(await uploadImages(files))
  const insertMarkdown = (urls: string[]) => {
    if (!urls.length) return
    const el = bodyRef.current
    setBody((b) => {
      const start = Math.min(el?.selectionStart ?? b.length, b.length)
      const end = Math.min(el?.selectionEnd ?? start, b.length)
      const before = b.slice(0, start)
      const after = b.slice(end)
      const lead = !before || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n'
      const trail = !after || after.startsWith('\n') ? '' : '\n\n'
      return before + lead + urls.map((url) => `![](${url})`).join('\n\n') + trail + after
    })
  }

  const restore = () => {
    if (!backup) return
    setTitle(backup.title)
    setDescription(backup.description)
    setBody(backup.body)
    setRichKey((k) => k + 1)
    setBackup(null)
  }
  const discard = () => {
    try {
      localStorage.removeItem(key)
    } catch {
      // Already gone.
    }
    setBackup(null)
  }

  // Where it is on the help center, once it's published there.
  const helpUrl =
    isPublic && path && published ? articleUrl(helpPath(path, path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, ''))) : null
  const saving = status.kind === 'saving'
  // "Saving…" only for a save that takes a moment; a quick one goes straight to "Saved".
  const showSaving = useDelayedBusy(saving)
  const isDraft = !plain && !published
  // Its help-center address, published or not, for the Publish confirmation.
  const publicUrl = isPublic && path ? articleUrl(helpPath(path, path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, ''))) : null
  // What it's used for once published, for the draft notes.
  const where = isPublic ? 'the help center and the AI’s answers' : 'the AI’s answers'

  return (
    <>
      <div className="sticky top-0 z-30 -mx-4 -mt-6 mb-8 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-background/90 px-4 py-2.5 backdrop-blur sm:-mx-8 sm:-mt-8 sm:px-8">
        <Link to="/dashboard/data" className={buttonClass('ghost', 'icon-sm', '-ml-2')} aria-label="Back to Knowledge">
          <ArrowLeftIcon />
        </Link>
        <nav aria-label="Location" className="flex min-w-0 items-center gap-1.5 text-[13px] text-muted-foreground">
          {article.location.map((name, i) => (
            <span key={i} className="flex min-w-0 items-center gap-1.5">
              {i > 0 && <span aria-hidden="true">/</span>}
              <span className="truncate">{name}</span>
            </span>
          ))}
        </nav>
        {isDraft && path && <Badge variant="muted">Draft</Badge>}
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          <p className="hidden text-xs text-muted-foreground sm:block" role="status" aria-live="polite">
            {saving && showSaving ? (
              plain ? 'Saving…' : status.as === 'published' ? 'Publishing…' : 'Saving draft…'
            ) : status.kind === 'error' ? (
              <span className="text-destructive">{status.message}</span>
            ) : dirty ? (
              'Unsaved changes'
            ) : status.kind === 'saved' ? (
              <span className="inline-flex items-center gap-1">
                <CheckIcon size={14} className="text-success" />
                {plain ? 'Saved' : status.as === 'published' ? 'Published' : 'Saved as draft'}
              </span>
            ) : base ? (
              <>
                Updated <RelativeTime iso={base} />
              </>
            ) : (
              'Not saved yet'
            )}
          </p>
          {!plain && <ModeSwitch mode={mode} onWrite={toWrite} onMarkdown={toMarkdown} />}
          {helpUrl && (
            <a href={helpUrl} target="_blank" rel="noopener noreferrer" className={buttonClass('ghost')}>
              View
              <ExternalIcon size={14} />
            </a>
          )}
          {plain ? (
            <Button onClick={() => void save('published')} disabled={saving || !dirty} title="Save (⌘S)">
              <BusyIcon busy={saving} size={14} />
              Save
            </Button>
          ) : (
            <>
              {published ? (
                // Back to draft, with any changes in the editor saved too.
                <Button variant="outline" onClick={() => ask('draft')} disabled={saving} title={`Move back to draft: out of ${where}`}>
                  <BusyIcon busy={saving && status.as === 'draft'} size={14} />
                  Unpublish
                </Button>
              ) : (
                <Button variant="outline" onClick={() => void save('draft')} disabled={saving || (!dirty && Boolean(path))} title="Save draft (⌘S)">
                  <BusyIcon busy={saving && status.as === 'draft'} size={14} />
                  Save draft
                </Button>
              )}
              <Button
                onClick={() => ask('published')}
                disabled={saving || (published && !dirty)}
                title={published ? 'Publish changes (⌘S)' : `Publish: add it to ${where}`}
              >
                <BusyIcon busy={saving && status.as === 'published'} size={14} />
                Publish
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="mx-auto max-w-[44rem] pb-24">
        {backup && (
          <Banner>
            <span>
              You have unsaved changes from <RelativeTime iso={backup.at} /> in this browser.
            </span>
            <span className="ml-auto flex gap-2">
              <Button size="sm" variant="ghost" onClick={discard}>
                Discard
              </Button>
              <Button size="sm" variant="outline" onClick={restore}>
                Restore
              </Button>
            </span>
          </Banner>
        )}
        {notice && (
          <Banner>
            <span>{notice}</span>
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setNotice(null)}>
              OK
            </Button>
          </Banner>
        )}
        {isDraft && path && !backup && (
          <Banner>
            <span className="text-muted-foreground">
              This is a draft. It isn’t in {where} until you publish it.
            </span>
          </Banner>
        )}
        {status.kind === 'error' && (
          <p role="alert" className="mb-6 text-sm text-destructive sm:hidden">
            {status.message}
          </p>
        )}

        {plain ? (
          <h1 className="editor-title">{fileName}</h1>
        ) : (
          <>
            <AutoTextarea
              ref={titleRef}
              value={title}
              onChange={(e) => {
                setTitle(e.target.value.replace(/\n/g, ' '))
                setTitleError(false)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  descriptionRef.current?.focus()
                }
              }}
              placeholder="Title"
              aria-label="Title"
              aria-invalid={titleError || undefined}
              aria-describedby={titleError ? 'title-error' : undefined}
              maxLength={150}
              className="editor-title"
              autoFocus={!article.path}
            />
            {titleError && (
              <p id="title-error" className="mt-1 text-sm text-destructive">
                Add a title before you save.
              </p>
            )}
            <AutoTextarea
              ref={descriptionRef}
              value={description}
              onChange={(e) => setDescription(e.target.value.replace(/\n/g, ' '))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  if (mode === 'write') rich.current?.focus()
                }
              }}
              placeholder={isPublic ? 'Summary, shown in search results and article lists' : 'Summary (optional)'}
              aria-label="Summary"
              maxLength={300}
              className="mt-3 w-full text-lg leading-snug text-muted-foreground"
            />
          </>
        )}

        <div className="mt-8">
          {mode === 'write' ? (
            <RichBody key={richKey} initial={body} apiRef={rich} onChange={setBody} onLossy={onLossy} onImages={uploadImages} />
          ) : (
            <AutoTextarea
              ref={bodyRef}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onPaste={(e) => {
                const files = imageFiles(e.clipboardData)
                if (plain || !files.length) return
                e.preventDefault()
                if (!pastedFromWeb(e.clipboardData)) void insertMarkdownImages(files)
                else {
                  // An image copied from a web page: link to it, as the visual editor does.
                  const src = webImageSrc(e.clipboardData)
                  if (src) insertMarkdown([src])
                  else setNotice('Only https:// images can be linked. Save the image and upload it instead.')
                }
              }}
              onDrop={(e) => {
                const files = imageFiles(e.dataTransfer)
                if (plain || !files.length) return
                e.preventDefault()
                e.currentTarget.focus()
                void insertMarkdownImages(files)
              }}
              aria-label={plain ? 'Note' : 'Article in Markdown'}
              placeholder={plain ? 'Write the note' : '## A heading\n\nWrite in Markdown.'}
              spellCheck
              className="min-h-[50vh] w-full font-mono text-sm leading-relaxed"
            />
          )}
        </div>

        {uploading > 0 && (
          <p
            role="status"
            className="fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-[13px]"
          >
            <SpinnerIcon size={14} className="text-muted-foreground" />
            {uploading === 1 ? 'Uploading image…' : `Uploading ${uploading} images…`}
          </p>
        )}

        <p className="mt-12 text-xs text-muted-foreground">
          {words === 1 ? '1 word' : `${words.toLocaleString()} words`}
          {words > 0 && `, about ${Math.max(1, Math.round(words / 230))} min read`}
          {/* See wordCount: code blocks and images are left out. */}
          {words > 0 && <span className="text-muted-foreground/70"> (counts the text people read; skips code and images)</span>}
        </p>
      </div>

      <ConfirmDialog
        open={confirming !== null}
        tone="primary"
        busy={saving}
        title={
          confirming === 'draft'
            ? `Unpublish “${title.trim()}”?`
            : published
              ? `Publish your changes to “${title.trim()}”?`
              : `Publish “${title.trim()}”?`
        }
        icon={confirming === 'draft' ? <EyeOffIcon size={18} /> : <SendIcon size={18} />}
        confirmLabel={confirming === 'draft' ? 'Unpublish' : 'Publish'}
        onClose={() => setConfirming(null)}
        onConfirm={async () => {
          const target = confirming
          if (!target) return
          await save(target)
          setConfirming(null)
        }}
      >
        {confirming === 'draft' ? (
          <>
            {isPublic ? 'It comes off the help center and the AI stops using it.' : 'The AI stops using it.'} It stays here as a draft
            {dirty ? ', with your unsaved changes,' : ''} and you can publish it again any time.
          </>
        ) : published ? (
          isPublic ? (
            'Visitors see them on the help center right away, and the AI answers from them.'
          ) : (
            'The AI answers from them right away.'
          )
        ) : isPublic ? (
          <>
            It goes live on the help center{publicUrl ? <> at <span className="font-mono text-xs">{publicUrl}</span></> : ''}, and the AI starts
            answering from it.
          </>
        ) : (
          'The AI starts answering from it. Private notes are never shown to visitors.'
        )}
      </ConfirmDialog>
      <ConflictDialog
        open={conflict}
        theirsAt={theirsAt}
        busy={saving}
        onClose={() => setConflict(false)}
        onOverwrite={() => void save(lastTarget.current, true)}
        onReload={() => {
          // The backup stays, so it's offered back after the reload.
          try {
            localStorage.setItem(key, JSON.stringify({ ...liveRef.current(), at: new Date().toISOString() } satisfies Backup))
          } catch {
            // Without storage the changes can't be kept.
          }
          leaving.current = true
          setConflict(false)
          void onReload()
        }}
      />
      <ConfirmDialog
        open={blocker.status === 'blocked'}
        title="Leave without saving?"
        icon={<LogOutIcon size={18} />}
        confirmLabel="Leave"
        onConfirm={() => blocker.proceed?.()}
        onClose={() => blocker.reset?.()}
      >
        Your changes aren’t saved. They’re kept in this browser, and you can restore them when you open this article again.
      </ConfirmDialog>
    </>
  )
}

function Banner({ children }: { children: ReactNode }) {
  return <div className="mb-6 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-muted/50 px-3.5 py-2 text-[13px]">{children}</div>
}

function ModeSwitch({ mode, onWrite, onMarkdown }: { mode: 'write' | 'markdown'; onWrite: () => void; onMarkdown: () => void }) {
  return (
    <Segmented
      label="Editing mode"
      size="sm"
      value={mode}
      onChange={(next) => (next === 'write' ? onWrite() : onMarkdown())}
      options={[
        { value: 'write', label: 'Write' },
        { value: 'markdown', label: 'Markdown' },
      ]}
    />
  )
}

// A textarea that grows with its text.
function AutoTextarea({ className, value, ref, ...props }: ComponentProps<'textarea'> & { value: string }) {
  const own = useRef<HTMLTextAreaElement>(null)
  const el = (ref as RefObject<HTMLTextAreaElement | null> | undefined) ?? own
  useLayoutEffect(() => {
    const t = el.current
    if (!t) return
    t.style.height = 'auto'
    t.style.height = `${t.scrollHeight}px`
  }, [value, el])
  return <textarea ref={el} value={value} rows={1} className={cn('block resize-none overflow-hidden bg-transparent outline-none placeholder:text-muted-foreground/60', className)} {...props} />
}

// --- The visual editor ---

interface RichApi {
  getMarkdown: () => string
  focus: () => void
}

function RichBody({
  initial,
  apiRef,
  onChange,
  onLossy,
  onImages,
}: {
  initial: string
  apiRef: RefObject<RichApi | null>
  onChange: (markdown: string) => void
  onLossy: () => void
  // Uploads images, returning the addresses of the ones that worked.
  onImages: (files: File[]) => Promise<string[]>
}) {
  const [linkOpen, setLinkOpen] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const callbacks = useRef({ onChange, onLossy, setLinkOpen, onImages })
  callbacks.current = { onChange, onLossy, setLinkOpen, onImages }
  const editorRef = useRef<Editor | null>(null)

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      ...articleExtensions,
      Placeholder.configure({
        placeholder: ({ editor, node }) =>
          editor.isEmpty ? 'Start writing. Type ## for a heading, - for a list, or use + for more.' : node.type.name === 'heading' ? 'Heading' : '',
      }),
    ],
    content: initial,
    contentType: 'markdown',
    editorProps: {
      attributes: { class: 'prose prose-article editor-body', 'aria-label': 'Article' },
      handleKeyDown: (view, event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && !view.state.selection.empty) {
          event.preventDefault()
          callbacks.current.setLinkOpen(true)
          return true
        }
        return false
      },
      // A pasted picture (a screenshot, a copied file) is uploaded. One copied
      // from a web page keeps its web address instead, the default paste.
      handlePaste: (view, event) => {
        const files = imageFiles(event.clipboardData)
        if (!files.length || pastedFromWeb(event.clipboardData) || !editorRef.current) return false
        event.preventDefault()
        void uploadInto(editorRef.current, files, view.state.selection.from, callbacks.current.onImages)
        return true
      },
      handleDrop: (view, event, _slice, moved) => {
        const files = imageFiles(event.dataTransfer)
        if (moved || !files.length || !editorRef.current) return false
        event.preventDefault()
        const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? view.state.selection.from
        void uploadInto(editorRef.current, files, at, callbacks.current.onImages)
        return true
      },
    },
    onCreate: ({ editor }) => {
      if (initial.trim() && !rendersSame(initial, editor.getMarkdown())) callbacks.current.onLossy()
    },
    onUpdate: ({ editor }) => {
      clearTimeout(timer.current)
      timer.current = setTimeout(() => callbacks.current.onChange(editor.getMarkdown()), 200)
    },
  })

  editorRef.current = editor

  useEffect(() => {
    apiRef.current = editor
      ? {
          getMarkdown: () => editor.getMarkdown(),
          // view.focus() now, so typing straight after lands here; the
          // command (which waits a frame) then puts the cursor at the start.
          focus: () => {
            editor.view.focus()
            editor.commands.focus('start')
          },
        }
      : null
    return () => {
      apiRef.current = null
      clearTimeout(timer.current)
    }
  }, [editor, apiRef])

  if (!editor) return <div className="prose prose-article editor-body" aria-busy="true" />
  return (
    <>
      <EditorContent editor={editor} />
      <FormatMenu editor={editor} linkOpen={linkOpen} setLinkOpen={setLinkOpen} />
      <TableMenu editor={editor} />
      <InsertMenu editor={editor} onImages={onImages} />
    </>
  )
}

const MENU = 'z-40 flex items-center gap-0.5 rounded-lg border border-border bg-card p-1 text-foreground'

function ToolButton({ label, active, onClick, children, className }: { label: string; active?: boolean; onClick: () => void; children: ReactNode; className?: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      // Keep the text selected while clicking.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        'grid h-8 min-w-8 place-items-center rounded-md px-1.5 text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring',
        active && 'bg-muted text-primary',
        className,
      )}
    >
      {children}
    </button>
  )
}

const Divider = () => <span aria-hidden="true" className="mx-0.5 h-5 w-px bg-border" />

// The bar over selected text (and over a link, to edit it).
function FormatMenu({ editor, linkOpen, setLinkOpen }: { editor: Editor; linkOpen: boolean; setLinkOpen: (open: boolean) => void }) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      empty: e.state.selection.empty,
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      strike: e.isActive('strike'),
      code: e.isActive('code'),
      link: e.isActive('link'),
      href: (e.getAttributes('link').href as string | undefined) ?? '',
      h2: e.isActive('heading', { level: 2 }),
      h3: e.isActive('heading', { level: 3 }),
      quote: e.isActive('blockquote'),
    }),
  })
  const open = useRef(linkOpen)
  open.current = linkOpen
  const chain = () => editor.chain().focus()

  return (
    <BubbleMenu
      editor={editor}
      pluginKey="format"
      options={{ placement: 'top', offset: 8 }}
      shouldShow={({ editor: e, state, view }) => {
        if (open.current) return true
        if (!view.hasFocus() || state.selection instanceof NodeSelection || e.isActive('codeBlock')) return false
        return !state.selection.empty || (e.isActive('link') && !e.isActive('table'))
      }}
      className={MENU}
    >
      {linkOpen ? (
        <LinkField
          initial={s.href}
          onDone={(href) => {
            setLinkOpen(false)
            if (href === null) chain().run()
            else if (href === '') chain().extendMarkRange('link').unsetLink().run()
            else chain().extendMarkRange('link').setLink({ href }).run()
          }}
        />
      ) : s.empty && s.link ? (
        <>
          <a href={s.href} target="_blank" rel="noopener noreferrer" className="max-w-56 truncate px-2 text-sm text-primary underline-offset-2 hover:underline">
            {s.href}
          </a>
          <Divider />
          <ToolButton label="Edit link" onClick={() => setLinkOpen(true)}>
            <LinkIcon />
          </ToolButton>
          <ToolButton label="Remove link" onClick={() => chain().extendMarkRange('link').unsetLink().run()}>
            <TrashIcon />
          </ToolButton>
        </>
      ) : (
        <>
          <ToolButton label="Bold (⌘B)" active={s.bold} onClick={() => chain().toggleBold().run()}>
            <BoldIcon />
          </ToolButton>
          <ToolButton label="Italic (⌘I)" active={s.italic} onClick={() => chain().toggleItalic().run()}>
            <ItalicIcon />
          </ToolButton>
          <ToolButton label="Strikethrough" active={s.strike} onClick={() => chain().toggleStrike().run()}>
            <StrikeIcon />
          </ToolButton>
          <ToolButton label="Code" active={s.code} onClick={() => chain().toggleCode().run()}>
            <CodeIcon />
          </ToolButton>
          <ToolButton label="Link (⌘K)" active={s.link} onClick={() => setLinkOpen(true)}>
            <LinkIcon />
          </ToolButton>
          <Divider />
          <ToolButton label="Heading" active={s.h2} onClick={() => chain().toggleHeading({ level: 2 }).run()} className="font-semibold">
            H2
          </ToolButton>
          <ToolButton label="Subheading" active={s.h3} onClick={() => chain().toggleHeading({ level: 3 }).run()} className="font-semibold">
            H3
          </ToolButton>
          <ToolButton label="Quote" active={s.quote} onClick={() => chain().toggleBlockquote().run()}>
            <QuoteIcon />
          </ToolButton>
        </>
      )}
    </BubbleMenu>
  )
}

// A web address, email or on-site path. Enter applies, Escape cancels, an
// empty field removes the link. onDone(null) is a cancel.
function LinkField({ initial, onDone }: { initial: string; onDone: (href: string | null) => void }) {
  const [value, setValue] = useState(initial)
  const [error, setError] = useState(false)
  return (
    <form
      className="flex items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault()
        if (!value.trim()) return onDone('')
        const href = normalizeHref(value)
        if (href) onDone(href)
        else setError(true)
      }}
    >
      <input
        autoFocus
        value={value}
        onChange={(e) => {
          setValue(e.target.value)
          setError(false)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            onDone(null)
          }
        }}
        placeholder="Paste a link, an email, or /articles/…"
        aria-label="Link address"
        aria-invalid={error || undefined}
        className={cn('h-8 w-72 rounded-md bg-transparent px-2 text-sm outline-none placeholder:text-muted-foreground', error && 'text-destructive')}
      />
      {error && <span className="pr-1 text-xs whitespace-nowrap text-destructive">Not a valid link</span>}
      <Button type="submit" size="sm" variant="ghost">
        Apply
      </Button>
    </form>
  )
}

// Row and column controls while the cursor is in a table.
function TableMenu({ editor }: { editor: Editor }) {
  const chain = () => editor.chain().focus()
  const button = (label: string, run: () => void, danger?: boolean) => (
    <ToolButton label={label} onClick={run} className={cn('px-2 text-[13px]', danger && 'text-destructive hover:bg-destructive/10')}>
      {label}
    </ToolButton>
  )
  return (
    <BubbleMenu
      editor={editor}
      pluginKey="table"
      options={{ placement: 'top', offset: 8 }}
      shouldShow={({ editor: e, state, view }) => view.hasFocus() && state.selection.empty && e.isActive('table')}
      className={cn(MENU, 'flex-wrap')}
    >
      {button('+ Row', () => chain().addRowAfter().run())}
      {button('+ Column', () => chain().addColumnAfter().run())}
      <Divider />
      {button('− Row', () => chain().deleteRow().run())}
      {button('− Column', () => chain().deleteColumn().run())}
      <Divider />
      {button('Delete table', () => chain().deleteTable().run(), true)}
    </BubbleMenu>
  )
}

// Uploads images and puts them at `at` (or at the cursor, if the article
// changed while they uploaded). On an empty line they take its place.
async function uploadInto(editor: Editor, files: File[], at: number, onImages: (files: File[]) => Promise<string[]>) {
  const doc = editor.state.doc
  const urls = await onImages(files)
  if (!urls.length || editor.isDestroyed) return
  const $pos = editor.state.doc.resolve(Math.min(editor.state.doc === doc ? at : editor.state.selection.from, editor.state.doc.content.size))
  const emptyLine = $pos.depth > 0 && $pos.parent.type.name === 'paragraph' && $pos.parent.childCount === 0
  editor
    .chain()
    .focus()
    .insertContentAt(
      emptyLine ? { from: $pos.before(), to: $pos.after() } : $pos.pos,
      urls.map((src) => ({ type: 'image', attrs: { src, alt: '' } })),
    )
    // Carry on writing below the images, rather than with the last one
    // selected (where typing or pasting would replace it).
    .command(({ tr }) => {
      const end = tr.selection.to
      if (!tr.doc.resolve(end).nodeAfter?.isTextblock) tr.insert(end, tr.doc.type.schema.nodes.paragraph!.create())
      tr.setSelection(TextSelection.create(tr.doc, end + 1))
      return true
    })
    .run()
}

// The + beside an empty line: headings, lists and other blocks.
function InsertMenu({ editor, onImages }: { editor: Editor; onImages: (files: File[]) => Promise<string[]> }) {
  const [open, setOpen] = useState(false)
  const [image, setImage] = useState(false)
  const keep = useRef(false)
  keep.current = image

  useEffect(() => {
    const close = () => {
      if (!keep.current) setOpen(false)
    }
    editor.on('selectionUpdate', close)
    return () => {
      editor.off('selectionUpdate', close)
    }
  }, [editor])

  const run = (fn: () => void) => () => {
    fn()
    setOpen(false)
  }
  const chain = () => editor.chain().focus()
  const blocks: Array<{ label: string; icon: ReactNode; run: () => void }> = [
    { label: 'Heading', icon: <span className="text-[13px] font-semibold">H2</span>, run: () => chain().setHeading({ level: 2 }).run() },
    { label: 'Subheading', icon: <span className="text-[13px] font-semibold">H3</span>, run: () => chain().setHeading({ level: 3 }).run() },
    { label: 'Bulleted list', icon: <ListIcon />, run: () => chain().toggleBulletList().run() },
    { label: 'Numbered list', icon: <ListOrderedIcon />, run: () => chain().toggleOrderedList().run() },
    { label: 'Quote', icon: <QuoteIcon />, run: () => chain().toggleBlockquote().run() },
    { label: 'Code block', icon: <CodeBlockIcon />, run: () => chain().toggleCodeBlock().run() },
    { label: 'Divider', icon: <MinusIcon />, run: () => chain().setHorizontalRule().run() },
    { label: 'Table', icon: <TableIcon />, run: () => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
  ]

  return (
    <FloatingMenu
      editor={editor}
      pluginKey="insert"
      options={{ placement: 'left', offset: 14 }}
      shouldShow={({ editor: e, view, state }) => {
        if (keep.current) return true
        const { $anchor, empty } = state.selection
        return view.hasFocus() && e.isEditable && empty && $anchor.depth === 1 && $anchor.parent.type.name === 'paragraph' && $anchor.parent.childCount === 0
      }}
      className="z-40"
    >
      <div className="relative flex items-center">
        <button
          type="button"
          aria-label={open ? 'Close' : 'Add a block'}
          aria-expanded={open}
          title="Add a block"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setOpen((o) => !o)
            setImage(false)
          }}
          className={cn(
            'grid size-7 place-items-center rounded-full border border-border bg-card text-muted-foreground hover:border-foreground/40 hover:text-foreground',
            open && 'rotate-45 text-foreground',
          )}
          data-motion
          style={{ transition: 'transform 150ms ease' }}
        >
          <PlusIcon size={16} />
        </button>
        {open && (
          <div className={cn(MENU, 'absolute top-1/2 left-full ml-2 -translate-y-1/2')}>
            {image ? (
              <ImageField
                onDone={(src) => {
                  setImage(false)
                  setOpen(false)
                  if (src) chain().setImage({ src, alt: '' }).run()
                  else editor.commands.focus()
                }}
                onUpload={(files) => {
                  const at = editor.state.selection.from
                  setImage(false)
                  setOpen(false)
                  void uploadInto(editor, files, at, onImages)
                }}
              />
            ) : (
              <>
                {blocks.map((b) => (
                  <ToolButton key={b.label} label={b.label} onClick={run(b.run)}>
                    {b.icon}
                  </ToolButton>
                ))}
                <ToolButton label="Image" onClick={() => setImage(true)}>
                  <ImageIcon />
                </ToolButton>
              </>
            )}
          </div>
        )}
      </div>
    </FloatingMenu>
  )
}

// An image's web address, or Upload to pick files from this computer.
function ImageField({ onDone, onUpload }: { onDone: (src: string | null) => void; onUpload: (files: File[]) => void }) {
  const [value, setValue] = useState('')
  const [error, setError] = useState(false)
  const picker = useRef<HTMLInputElement>(null)
  return (
    <form
      className="flex items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault()
        if (isImageUrl(value)) onDone(value.trim())
        else setError(true)
      }}
    >
      <input
        autoFocus
        value={value}
        onChange={(e) => {
          setValue(e.target.value)
          setError(false)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            onDone(null)
          }
        }}
        placeholder="Paste an image link"
        aria-label="Image address"
        aria-invalid={error || undefined}
        className="h-8 w-60 rounded-md bg-transparent px-2 text-sm outline-none placeholder:text-muted-foreground"
      />
      {error && <span className="pr-1 text-xs whitespace-nowrap text-destructive">Use an https:// link</span>}
      <Button type="submit" size="sm" variant="ghost">
        Add
      </Button>
      <Divider />
      <Button type="button" size="sm" variant="ghost" onClick={() => picker.current?.click()}>
        <UploadIcon size={14} />
        Upload
      </Button>
      <input
        ref={picker}
        type="file"
        accept={ACCEPTED_IMAGES}
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])]
          e.target.value = ''
          if (files.length) onUpload(files)
        }}
      />
    </form>
  )
}
