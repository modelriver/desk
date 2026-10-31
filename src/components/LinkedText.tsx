import { splitLinks } from '../lib/links.ts'

// Plain text with its web addresses as links. They open in a new tab, and
// are nofollow and ugc: customers wrote some of them, so they get no ranking
// credit from the help center, and no referrer or window access either.
export function LinkedText({ text }: { text: string }) {
  return (
    <>
      {splitLinks(text).map((p, i) =>
        p.href ? (
          <a key={i} href={p.href} target="_blank" rel="nofollow ugc noopener noreferrer" className="underline underline-offset-2 hover:opacity-80">
            {p.text}
          </a>
        ) : (
          p.text
        ),
      )}
    </>
  )
}
