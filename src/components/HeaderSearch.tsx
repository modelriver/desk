import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { SearchIcon } from './icons.tsx'
import { MAX_SEARCH_QUERY } from '../lib/search.ts'


// Search boxes the shortcut can jump to: the header's, or /help's own.
const SEARCH_INPUTS = ['header-search', 'help-search']

// Article search in the site header. Enter opens the results on /help.
// ⌘K (Ctrl+K on Windows and Linux) jumps to search from anywhere: the box in
// view, or /help when none is (on phones). `box` is false on /help, which has its own.
export function HeaderSearch({ box = true }: { box?: boolean }) {
  const navigate = useNavigate()
  const [value, setValue] = useState('')
  const input = useRef<HTMLInputElement>(null)
  // Known only in the browser, so the server render shows no hint.
  const [hint, setHint] = useState<string | null>(null)

  useEffect(() => {
    setHint(/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '⌘K' : 'Ctrl K')
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'k' || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return
      e.preventDefault()
      const visible = SEARCH_INPUTS.map((id) => document.getElementById(id) as HTMLInputElement | null).find(
        (el) => el && el.offsetParent !== null,
      )
      if (visible) {
        visible.focus()
        visible.select()
      } else {
        void navigate({ to: '/help' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navigate])

  if (!box) return null
  return (
    <>
      <form
        role="search"
        className="relative hidden sm:block"
        onSubmit={(e) => {
          e.preventDefault()
          const q = value.trim().slice(0, MAX_SEARCH_QUERY)
          void navigate({ to: '/help', search: q ? { q } : {} })
          setValue('')
          input.current?.blur()
        }}
      >
        <label htmlFor="header-search" className="sr-only">
          Search articles
        </label>
        <SearchIcon size={15} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground" />
        <input
          ref={input}
          id="header-search"
          type="search"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') e.currentTarget.blur()
          }}
          maxLength={MAX_SEARCH_QUERY}
          placeholder="Search articles"
          autoComplete="off"
          aria-keyshortcuts="Meta+K Control+K"
          className="peer h-8 w-56 rounded-md border border-input bg-card pr-14 pl-8 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring [&::-webkit-search-cancel-button]:hidden"
        />
        {/* The shortcut hint, hidden while the box has focus. */}
        {hint && (
          <kbd
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 rounded border border-border px-1 font-sans text-[11px] leading-4 text-muted-foreground peer-focus:hidden"
          >
            {hint}
          </kbd>
        )}
      </form>
      <Link
        to="/help"
        aria-label="Search articles"
        className="grid size-9 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground sm:hidden"
      >
        <SearchIcon size={18} />
      </Link>
    </>
  )
}
