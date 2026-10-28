import { parseFrontMatter } from './front-matter.ts'

// An article file is front matter plus a Markdown body. The editor shows the
// title and description as their own fields, so the body it edits has no
// leading "# Title" heading; the article page adds the title itself when the
// body doesn't start with one. Front-matter keys the editor doesn't know
// (category, order, anything custom) are kept as they were.
//
// A draft has `status: draft` in its front matter (`draft: true`, the spelling
// other tools use, counts too). Drafts stay out of the help center, search and
// anything sent to the AI until they're published. Only Markdown files can be
// drafts: plain-text notes have no front matter.

export interface ArticleFields {
  title: string
  description: string
  body: string
}

export type ArticleStatus = 'published' | 'draft'

const LEADING_H1 = /^\s*#\s+(.+?)\s*#*\s*(?:\n|$)/
const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/
const STATUS_LINE = /^(status|draft)\s*:/i

export function statusOf(data: Record<string, string>): ArticleStatus {
  if ((data.status ?? '').trim().toLowerCase() === 'draft') return 'draft'
  if (['true', 'yes'].includes((data.draft ?? '').trim().toLowerCase())) return 'draft'
  return 'published'
}

export function canBeDraft(file: string): boolean {
  return file.toLowerCase().endsWith('.md')
}

export function isDraft(text: string, file: string): boolean {
  return canBeDraft(file) && statusOf(parseFrontMatter(text).data) === 'draft'
}

// The same file with only its status changed: everything else in the front
// matter and the body stays exactly as it was.
export function withStatus(source: string, status: ArticleStatus): string {
  const match = FRONT_MATTER.exec(source)
  if (!match) return status === 'draft' ? `---\nstatus: draft\n---\n\n${source}` : source
  const lines = match[1]!.split(/\r?\n/).filter((line) => !STATUS_LINE.test(line))
  if (status === 'draft') lines.push('status: draft')
  const rest = source.slice(match[0].length)
  return lines.some((l) => l.trim()) ? `---\n${lines.join('\n')}\n---\n${rest}` : rest.replace(/^\s*\n/, '')
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

export function hasLeadingH1(body: string): boolean {
  return LEADING_H1.test(body)
}

export function articleBodyForEditor(text: string, file: string): ArticleFields {
  if (file.endsWith('.txt')) return { title: file.slice(file.lastIndexOf('/') + 1), description: '', body: text }
  const { data, body } = parseFrontMatter(text)
  const h1 = LEADING_H1.exec(body)
  const title = data.title || h1?.[1] || ''
  // The heading is the title shown twice: edit it once, in the title field.
  const withoutTitle = h1 && same(h1[1]!, title) ? body.slice(h1[0].length) : body
  return { title, description: data.description ?? '', body: withoutTitle.replace(/^\s*\n/, '') }
}

// One-line front-matter value, quoted when it could be misread.
function yamlValue(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return /[:#]|^["'\s]|["'\s]$/.test(flat) ? `"${flat.replace(/"/g, "'")}"` : flat
}

// `status` sets draft or published; left out, the file keeps the one it had.
export function serializeArticle(fields: ArticleFields, previous: string | null, status?: ArticleStatus): string {
  const kept = previous ? parseFrontMatter(previous).data : {}
  const lines = [`title: ${yamlValue(fields.title)}`]
  if (fields.description.trim()) lines.push(`description: ${yamlValue(fields.description)}`)
  for (const [key, value] of Object.entries(kept)) {
    if (key !== 'title' && key !== 'description') lines.push(`${key}: ${yamlValue(value)}`)
  }
  const body = fields.body.replace(/\s+$/, '')
  const text = `---\n${lines.join('\n')}\n---\n\n${body}\n`
  return status ? withStatus(text, status) : text
}

// Words a reader sees, roughly: Markdown syntax and code blocks don't count.
export function wordCount(body: string): number {
  const text = body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\]\([^)]*\)/g, ' ')
    .replace(/[#>*_`~[\]|-]+/g, ' ')
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length
}
