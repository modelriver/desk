// Web addresses in plain text (ticket messages and replies): http and https
// only, so nothing like javascript: can become a link. A trailing full stop,
// comma or closing bracket is left out, as it's almost always the sentence's.
export const URL_PATTERN = /https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g

export type TextPart = { text: string; href?: string }

export function splitLinks(text: string): TextPart[] {
  const parts: TextPart[] = []
  let last = 0
  for (const m of text.matchAll(URL_PATTERN)) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index) })
    parts.push({ text: m[0], href: m[0] })
    last = m.index + m[0].length
  }
  if (last < text.length) parts.push({ text: text.slice(last) })
  return parts
}
