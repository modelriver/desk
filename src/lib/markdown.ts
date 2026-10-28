import MarkdownIt from 'markdown-it'

// html: false escapes any raw HTML in the source, and markdown-it's built-in
// validateLink rejects javascript:, vbscript:, file: and non-image data: URLs.
// That makes rendered help-center articles and AI answers safe to inject.
function createRenderer({ images, anchors }: { images: boolean; anchors: boolean }) {
  const md = new MarkdownIt({ html: false, linkify: true, typographer: false })

  // Articles: every heading gets a stable id (from its text), and section
  // headings a link to themselves, so any part of an article can be linked.
  if (anchors) {
    md.core.ruler.push('heading_ids', (state) => {
      const slug = slugger()
      state.tokens.forEach((token, i) => {
        if (token.type === 'heading_open') token.attrSet('id', slug(inlineText(state.tokens[i + 1])))
      })
    })
    md.renderer.rules.heading_close = (tokens, idx, options, _env, self) => {
      const open = tokens.findLast((t, i) => i < idx && t.type === 'heading_open')
      const id = open?.attrGet('id') == null ? null : String(open.attrGet('id'))
      const level = Number(tokens[idx]!.tag.slice(1))
      const anchor =
        id && level >= 2 && level <= 4
          ? `<a class="heading-anchor" href="#${md.utils.escapeHtml(id)}" aria-label="Link to this section">#</a>`
          : ''
      return anchor + self.renderToken(tokens, idx, options)
    }
  }

  const defaultLinkOpen =
    md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))

  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx]!
    const href = String(token.attrGet('href') ?? '')
    if (/^https?:\/\//i.test(href)) {
      token.attrSet('target', '_blank')
      token.attrSet('rel', 'noopener noreferrer nofollow')
    }
    return defaultLinkOpen(tokens, idx, options, env, self)
  }

  // Chat text can be steered by visitors (through the AI), so an image there
  // could make a team member's browser call any server. Show its alt text instead.
  if (!images) md.renderer.rules.image = (tokens, idx) => md.utils.escapeHtml(tokens[idx]!.content)

  return md
}

const articles = createRenderer({ images: true, anchors: true })
const chat = createRenderer({ images: false, anchors: false })

// Help-center articles and data files, written by your team.
export function renderMarkdown(source: string): string {
  return articles.render(source)
}

// True when two Markdown sources look the same to a reader (the same HTML,
// ignoring whitespace between tags). The editor checks this before opening a
// file visually, so it never quietly changes what's published.
export function rendersSame(a: string, b: string): boolean {
  const html = (s: string) => renderMarkdown(s).replace(/>\s+</g, '><').replace(/\s+/g, ' ').trim()
  return a === b || html(a) === html(b)
}

// AI answers and agent replies: no images.
export function renderChatMarkdown(source: string): string {
  return chat.render(source)
}

// --- Heading ids and the article outline ---

// "Billing & plans (2026)" -> "billing-plans-2026". Kept to ASCII letters and
// digits so ids survive copy-paste into any chat or doc.
export function headingSlug(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

// Ids for one document: repeats get -1, -2 so each stays unique.
export function slugger() {
  const seen = new Map<string, number>()
  return (text: string) => {
    const base = headingSlug(text) || 'section'
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    return n ? `${base}-${n}` : base
  }
}

type Token = ReturnType<InstanceType<typeof MarkdownIt>['parse']>[number]

function inlineText(token: Token | undefined): string {
  if (!token?.children) return token?.content ?? ''
  return token.children.map((c: Token) => (c.type === 'text' || c.type === 'code_inline' ? c.content : '')).join('')
}

export interface OutlineEntry {
  id: string
  text: string
  level: 2 | 3
}

// The article's sections (h2 and h3), with the same ids the page uses.
export function articleOutline(source: string): OutlineEntry[] {
  const tokens = articles.parse(source, {})
  const out: OutlineEntry[] = []
  tokens.forEach((t, i) => {
    if (t.type !== 'heading_open' || (t.tag !== 'h2' && t.tag !== 'h3')) return
    out.push({ id: String(t.attrGet('id') ?? ''), text: inlineText(tokens[i + 1]), level: t.tag === 'h2' ? 2 : 3 })
  })
  return out
}
