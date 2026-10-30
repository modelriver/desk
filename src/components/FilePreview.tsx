import { useEffect, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { readDataFile } from '../functions/data.ts'
import { Markdown } from './Markdown.tsx'
import { Badge, buttonClass, Button } from './ui.tsx'
import { ExternalIcon, PencilIcon, XIcon } from './icons.tsx'
import { RelativeTime } from './RelativeTime.tsx'
import { BusyIcon } from './BusyIcon.tsx'
import { errorMessage } from '../lib/errors.ts'
import { articleUrl } from '../lib/help-path.ts'

type Preview = Awaited<ReturnType<typeof readDataFile>>

// Read-only preview of a data file: Markdown rendered like a help article,
// text shown exactly as written. Uses the native <dialog>, so Escape, focus
// and the backdrop are handled by the browser.
export function FilePreview({
  file,
  onClose,
}: {
  file: { visibility: 'public' | 'private'; path: string; name: string } | null
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const read = useServerFn(readDataFile)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const el = dialog.current
    if (!el) return
    if (file && !el.open) el.showModal()
    if (!file && el.open) el.close()
  }, [file])

  useEffect(() => {
    if (!file) return
    let cancelled = false
    setPreview(null)
    setError(null)
    read({ data: { visibility: file.visibility, path: file.path } })
      .then((p) => !cancelled && setPreview(p))
      .catch((err) => !cancelled && setError(errorMessage(err, 'Couldn’t open this file.')))
    return () => {
      cancelled = true
    }
  }, [file, read])

  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      // Clicking the backdrop (the dialog element itself, outside the panel) closes it.
      onClick={(e) => e.target === e.currentTarget && dialog.current?.close()}
      aria-label={file ? `Preview of ${file.name}` : 'File preview'}
      className="m-auto h-[min(85dvh,56rem)] w-[min(52rem,calc(100vw-2rem))] max-w-none overflow-hidden rounded-2xl border border-border bg-card p-0 text-foreground backdrop:bg-black/40"
    >
      {file && (
        <div className="flex h-full flex-col">
          <header className="flex items-center gap-3 border-b border-border px-5 py-3">
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2">
                <span className="truncate font-mono text-sm">{file.name}</span>
                <Badge variant={file.visibility === 'public' ? 'default' : 'muted'} className="capitalize">
                  {file.visibility}
                </Badge>
              </p>
              {preview && (
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {(preview.size / 1024).toFixed(1)} KB, updated <RelativeTime iso={preview.updatedAt} />
                </p>
              )}
            </div>
            {preview?.helpPath && (
              <a href={articleUrl(preview.helpPath)} target="_blank" rel="noopener noreferrer" className={buttonClass('outline', 'sm')}>
                <ExternalIcon size={14} />
                Open in help center
              </a>
            )}
            <Link to="/dashboard/editor" search={{ visibility: file.visibility, path: file.path }} className={buttonClass('outline', 'sm')}>
              <PencilIcon size={14} />
              Edit
            </Link>
            <Button variant="ghost" size="icon-sm" aria-label="Close preview" onClick={() => dialog.current?.close()}>
              <XIcon />
            </Button>
          </header>

          <div className="flex-1 overflow-y-auto px-6 py-6 sm:px-10">
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : !preview ? (
              <div className="grid h-full place-items-center text-muted-foreground">
                <BusyIcon busy size={18} />
              </div>
            ) : preview.format === 'markdown' ? (
              <div className="mx-auto max-w-[42rem]">
                {(preview.title || preview.description) && (
                  <div className="mb-6 rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm">
                    {preview.title && (
                      <p>
                        <span className="text-muted-foreground">Title: </span>
                        {preview.title}
                      </p>
                    )}
                    {preview.description && (
                      <p className="mt-0.5">
                        <span className="text-muted-foreground">Description: </span>
                        {preview.description}
                      </p>
                    )}
                  </div>
                )}
                <Markdown source={preview.body} className="prose-article" />
              </div>
            ) : (
              <pre className="font-mono text-[13px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
                {preview.body}
              </pre>
            )}
          </div>
        </div>
      )}
    </dialog>
  )
}
