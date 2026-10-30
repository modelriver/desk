import { useEffect, useState } from 'react'
import { SearchIcon } from './icons.tsx'
import { SearchDialog } from './SearchDialog.tsx'

// Article search in the site header: a button that opens the search window,
// which shows results as you type. ⌘K (Ctrl+K on Windows and Linux) opens it
// from anywhere. `box` is false on /articles, which has its own search box:
// there ⌘K goes to that box instead.
export function HeaderSearch({ box = true }: { box?: boolean }) {
  const [open, setOpen] = useState(false)
  // Known only in the browser, so the server render shows no hint.
  const [hint, setHint] = useState<string | null>(null)

  useEffect(() => {
    setHint(/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '⌘K' : 'Ctrl K')
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'k' || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return
      e.preventDefault()
      const pageBox = box ? null : (document.getElementById('help-search') as HTMLInputElement | null)
      if (pageBox && pageBox.offsetParent !== null) {
        pageBox.focus()
        pageBox.select()
      } else {
        setOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [box])

  return (
    <>
      {box && (
        <>
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-haspopup="dialog"
            aria-keyshortcuts="Meta+K Control+K"
            className="relative hidden h-8 w-56 items-center gap-2 rounded-md border border-input bg-card pr-2 pl-2.5 text-sm text-muted-foreground outline-none hover:border-foreground/25 focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring sm:flex"
          >
            <SearchIcon size={15} />
            Search articles
            {hint && (
              <kbd aria-hidden="true" className="ml-auto rounded border border-border px-1 font-sans text-[11px] leading-4">
                {hint}
              </kbd>
            )}
          </button>
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label="Search articles"
            aria-haspopup="dialog"
            className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground sm:hidden"
          >
            <SearchIcon size={18} />
          </button>
        </>
      )}
      <SearchDialog open={open} onClose={() => setOpen(false)} />
    </>
  )
}
