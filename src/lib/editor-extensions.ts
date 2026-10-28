import StarterKit from '@tiptap/starter-kit'
import { TableKit } from '@tiptap/extension-table'
import { Image } from '@tiptap/extension-image'
import { Markdown } from '@tiptap/markdown'

// What the article editor can write. Everything here has a plain Markdown
// form, so the file on disk stays readable and diffable; underline has none,
// so it's off.

// Links an article may have: web pages, email, and paths or sections on this
// site. Anything else (javascript:, data:, …) is refused.
export function isAllowedHref(href: string): boolean {
  // A path may not start with // or /\, which browsers treat as another site.
  return /^(https?:\/\/[^\s]+|mailto:[^\s]+|\/(?![\/\\])[^\s]*|#[^\s]*)$/i.test(href.trim())
}

// What someone typed into the link field, as a link: "example.com" becomes
// "https://example.com". Null when it can't be one.
export function normalizeHref(input: string): string | null {
  const href = input.trim()
  if (!href) return null
  if (isAllowedHref(href)) return href
  if (/^[^\s@/:]+@[^\s@]+\.[^\s@]+$/.test(href)) return `mailto:${href}`
  if (/^[^\s/:]+\.[^\s]+$/.test(href)) return `https://${href}`
  return null
}

// Images are linked, not uploaded.
export function isImageUrl(src: string): boolean {
  return /^https:\/\/[^\s]+$/i.test(src.trim())
}

export const articleExtensions = [
  StarterKit.configure({
    underline: false,
    link: {
      openOnClick: false,
      autolink: true,
      defaultProtocol: 'https',
      isAllowedUri: (url) => isAllowedHref(url),
    },
  }),
  TableKit.configure({ table: { resizable: false } }),
  Image.configure({ allowBase64: false }),
  Markdown,
]
