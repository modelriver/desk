import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildIndex,
  chunkDoc,
  groupByCategory,
  plainText,
  relatedArticles,
  searchArticles,
  snippetFor,
  toDoc,
  type Doc,
} from '../src/lib/content-core.ts'
import { articleOutline, headingSlug, renderChatMarkdown, renderMarkdown } from '../src/lib/markdown.ts'
import { robotsTxt, siteOrigin, sitemapXml } from '../src/lib/seo.ts'
import { linkCitations } from '../src/lib/citations.ts'
import { buildContextMessage } from '../src/lib/prompt-core.ts'

const article = (file: string, fm: string, body: string, visibility: 'public' | 'private' = 'public') =>
  toDoc(file, `---\n${fm}\n---\n${body}`, visibility)

const docs: Doc[] = [
  article('export.md', 'title: Exporting your data\ndescription: Download notebooks\ncategory: Your data\norder: 40', '# Exporting your data\n\n## Export a notebook\n\nOpen the notebook and choose Export. Pick Markdown or PDF.\n\n## Export everything\n\nOwners can export the whole workspace as a zip.'),
  article('backup.md', 'title: Backups\ndescription: How backups work\ncategory: Your data\norder: 45', '# Backups\n\nWe back up every workspace nightly.'),
  article('billing.md', 'title: Billing and plans\ndescription: Prices and invoices\ncategory: Billing\norder: 30', '# Billing and plans\n\n## Invoices\n\nInvoices are emailed monthly. You can export invoices as PDF.'),
  article('start.md', 'title: Getting started\ndescription: First steps', '# Getting started\n\nCreate your account.'),
  article('playbook.md', 'title: Refund playbook', '# Refunds\n\nSecret refund export process for staff only.', 'private'),
]
const publicIndex = buildIndex(docs.filter((d) => d.visibility === 'public').flatMap(chunkDoc))

test('category and order come from front matter, with defaults for older files', () => {
  assert.equal(docs[0]!.category, 'Your data')
  assert.equal(docs[0]!.order, 40)
  assert.equal(docs[3]!.category, 'General')
  assert.equal(docs[3]!.order, 1000)
  assert.equal(article('x.md', 'order: soon', 'x').order, 1000, 'a non-number order falls back')
})

test('sections follow their first article’s order, and unplaced General comes last', () => {
  const sections = groupByCategory(docs.filter((d) => d.visibility === 'public'))
  assert.deepEqual(
    sections.map((s) => [s.category, s.articles.map((a) => a.slug)]),
    [
      ['Billing', ['billing']],
      ['Your data', ['export', 'backup']],
      ['General', ['start']],
    ],
  )
})

test('search finds articles, one result each, with the matching section and an extract', () => {
  const hits = searchArticles(publicIndex, docs, 'export pdf')
  assert.ok(hits.length >= 2)
  assert.equal(new Set(hits.map((h) => h.slug)).size, hits.length, 'one hit per article')
  const exportHit = hits.find((h) => h.slug === 'export')!
  assert.equal(exportHit.heading, 'Export a notebook')
  assert.match(exportHit.snippet, /Export/i)
  assert.equal(exportHit.category, 'Your data')
})

test('search never returns private notes, even when they match best', () => {
  const allIndex = buildIndex(docs.flatMap(chunkDoc))
  for (const index of [publicIndex, allIndex]) {
    assert.ok(!searchArticles(index, docs, 'refund playbook staff').some((h) => h.slug === 'playbook'))
  }
})

test('an empty or filler-only query finds nothing', () => {
  assert.deepEqual(searchArticles(publicIndex, docs, ''), [])
  assert.deepEqual(searchArticles(publicIndex, docs, 'how do I'), [])
})

test('extracts are plain text around the first match, trimmed on word boundaries', () => {
  assert.equal(plainText('**Bold** and [a link](https://x.test) with `code`'), 'Bold and a link with code')
  const long = `${'intro words '.repeat(40)}the export button is here ${'more words '.repeat(40)}`
  const s = snippetFor(long, 'export', 80)
  assert.match(s, /^….*export button.*…$/)
  assert.ok(s.length <= 84)
})

test('related articles: the rest of the section first, then similar ones, never itself or private', () => {
  const related = relatedArticles(docs[0]!, docs, publicIndex)
  assert.equal(related[0]!.slug, 'backup')
  assert.ok(!related.some((r) => r.slug === 'export' || r.slug === 'playbook'))
  assert.ok(related.length <= 3)
})

test('article headings get unique ids and a section link; chat text gets neither', () => {
  const source = '# Title\n\n## Plans & pricing\n\n### Free plan\n\n## Plans & pricing'
  const html = renderMarkdown(source)
  assert.match(html, /<h2 id="plans-pricing">/)
  assert.match(html, /<h2 id="plans-pricing-1">/)
  assert.match(html, /<a class="heading-anchor" href="#free-plan"/)
  assert.doesNotMatch(renderChatMarkdown(source), /id=|heading-anchor/)
})

test('the outline lists h2 and h3 with the same ids as the page', () => {
  const source = '# Title\n\n## Export a notebook\n\n### PDF\n\n#### Deep\n\n## Export a notebook'
  const outline = articleOutline(source)
  assert.deepEqual(outline, [
    { id: 'export-a-notebook', text: 'Export a notebook', level: 2 },
    { id: 'pdf', text: 'PDF', level: 3 },
    { id: 'export-a-notebook-1', text: 'Export a notebook', level: 2 },
  ])
  for (const { id } of outline) assert.match(renderMarkdown(source), new RegExp(`id="${id}"`))
})

test('heading ids are plain ASCII, and headings with odd text stay safe', () => {
  assert.equal(headingSlug('Café & Crème: 2026!'), 'cafe-creme-2026')
  assert.match(renderMarkdown('## <script>x</script>'), /id="script-x-script"/)
  assert.doesNotMatch(renderMarkdown('## <script>x</script>'), /<script>/)
})

test('the sitemap lists absolute, escaped URLs with dates', () => {
  const xml = sitemapXml('https://help.acme.test', [{ path: '/help/a&b', modifiedAt: '2026-10-26T10:00:00.000Z' }, { path: '/' }])
  assert.match(xml, /^<\?xml version="1.0"/)
  assert.match(xml, /<loc>https:\/\/help\.acme\.test\/help\/a&amp;b<\/loc><lastmod>2026-10-26<\/lastmod>/)
  assert.match(xml, /<loc>https:\/\/help\.acme\.test\/<\/loc><\/url>/)
})

test('robots.txt keeps the dashboard out and points to the sitemap', () => {
  const txt = robotsTxt('https://help.acme.test')
  assert.match(txt, /Disallow: \/dashboard/)
  assert.match(txt, /Sitemap: https:\/\/help\.acme\.test\/sitemap\.xml/)
  assert.equal(siteOrigin('', 'http://localhost:3100/sitemap.xml?x=1'), 'http://localhost:3100')
  assert.equal(siteOrigin('https://help.acme.test', 'http://internal:3000/'), 'https://help.acme.test')
})

test('the AI is told to mark answers the articles don’t cover, and the marker is never shown', () => {
  assert.match(buildContextMessage([]).content, /\[\[unsure\]\]/)
  assert.equal(linkCitations('I’m not sure about that. [[unsure]]', new Map()).trim(), 'I’m not sure about that.')
})

test('singular and plural find each other, without mangling short or -ss words', async () => {
  const { tokenize } = await import('../src/lib/content-core.ts')
  assert.deepEqual(tokenize('invoices policies notes'), tokenize('invoice policy note'))
  assert.deepEqual(tokenize('access status bus'), ['access', 'status', 'bus'])
  assert.ok(searchArticles(publicIndex, docs, 'invoice').some((h) => h.slug === 'billing'))
})

test('a subfolder becomes a subsection, in the order its articles come', () => {
  const a = (slug: string, category: string, subcategory: string | null, order: number) => ({
    slug,
    path: ['billing', subcategory?.toLowerCase().replace(/ /g, '-'), slug].filter(Boolean).join('/'),
    title: slug,
    description: '',
    category,
    subcategory,
    order,
  })
  const sections = groupByCategory([
    a('refunds', 'Billing', 'Invoices', 30),
    a('plans', 'Billing', null, 10),
    a('vat', 'Billing', 'Invoices', 20),
    a('cards', 'Billing', 'Payment methods', 40),
  ])
  assert.equal(sections.length, 1)
  assert.deepEqual(sections[0]!.articles.map((x) => x.slug), ['plans'])
  assert.deepEqual(
    sections[0]!.subsections.map((s) => [s.name, s.articles.map((x) => x.slug)]),
    [
      ['Invoices', ['vat', 'refunds']],
      ['Payment methods', ['cards']],
    ],
  )
})

test('an article’s URL is its file name, whichever folder it sits in', () => {
  assert.equal(toDoc('billing/invoices/refunds.md', '# Refunds', 'public').slug, 'refunds')
})
