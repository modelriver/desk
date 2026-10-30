import type { Source } from './prompt-core.ts'
import { articleUrl } from './help-path.ts'

const MARKER = /\[\[([a-z0-9-]{1,80})\]\]/g

// Replace [[slug]] markers with Markdown links, but only for slugs we know are
// public articles. Anything else (a hallucinated or private slug) is dropped.
export function linkCitations(text: string, known: Map<string, Source>): string {
  return text.replace(MARKER, (_m, slug: string) => {
    const source = known.get(slug)
    return source ? `[${source.title}](${articleUrl(source.path)})` : ''
  })
}

export function citedSlugs(text: string, known: Map<string, Source>): Source[] {
  const seen = new Map<string, Source>()
  for (const m of text.matchAll(MARKER)) {
    const source = known.get(m[1]!)
    if (source) seen.set(source.slug, source)
  }
  return [...seen.values()]
}

// While a reply is still streaming, hide a half-written marker such as "[[getting-st".
export function hidePartialMarker(text: string): string {
  return text.replace(/\[\[?[a-z0-9-]*\]?$/, '')
}
