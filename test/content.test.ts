import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildIndex,
  chunkDoc,
  parseFrontMatter,
  safeFileName,
  slugFromFilename,
  toDoc,
} from '../src/lib/content-core.ts'

test('parseFrontMatter reads simple key/value pairs and strips quotes', () => {
  const { data, body } = parseFrontMatter('---\ntitle: "Hello: world"\ndescription: Short\n---\n# Body\n')
  assert.equal(data.title, 'Hello: world')
  assert.equal(data.description, 'Short')
  assert.equal(body, '# Body\n')
})

test('parseFrontMatter leaves documents without front matter alone', () => {
  assert.deepEqual(parseFrontMatter('# Just text'), { data: {}, body: '# Just text' })
})

test('toDoc falls back to the first heading, then the slug, for the title', () => {
  assert.equal(toDoc('My Guide.md', '# Real title\ntext', 'public').title, 'Real title')
  assert.equal(toDoc('no-heading.md', 'text only', 'public').title, 'no-heading')
  assert.equal(slugFromFilename('Hello World!.md'), 'hello-world')
})

test('chunkDoc splits on headings and keeps the heading with each chunk', () => {
  const doc = toDoc('a.md', '# A\nintro\n## Billing\npay monthly\n## Export\nzip file', 'public')
  const chunks = chunkDoc(doc)
  assert.deepEqual(
    chunks.map((c) => [c.heading, c.text]),
    [
      ['A', 'intro'],
      ['Billing', 'pay monthly'],
      ['Export', 'zip file'],
    ],
  )
})

test('BM25 ranks the most relevant chunk first', () => {
  const docs = [
    toDoc('billing.md', '# Billing\nInvoices are emailed monthly. Cancel any time.', 'public'),
    toDoc('export.md', '# Export\nExport notebooks as Markdown or PDF.', 'public'),
    toDoc('notes.md', '# Internal\nRefunds within 14 days.', 'private'),
  ]
  const index = buildIndex(docs.flatMap(chunkDoc))
  assert.equal(index.search('how do I export to PDF?')[0]?.slug, 'export')
  assert.equal(index.search('refunds')[0]?.visibility, 'private')
  assert.deepEqual(index.search('the and of'), [])
})

test('safeFileName normalises names and rejects disallowed types', () => {
  assert.equal(safeFileName('../../My Article.MD', ['.md']), 'my-article.md')
  assert.equal(safeFileName('C:\\temp\\notes.txt', ['.md', '.txt']), 'notes.txt')
  assert.throws(() => safeFileName('evil.html', ['.md']))
  assert.throws(() => safeFileName('script.md.exe', ['.md']))
  assert.throws(() => safeFileName('.md', ['.md']))
})
