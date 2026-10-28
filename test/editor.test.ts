import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { getSchema } from '@tiptap/react'
import { MarkdownManager } from '@tiptap/markdown'
import { articleExtensions, isAllowedHref, isImageUrl, normalizeHref } from '../src/lib/editor-extensions.ts'
import { articleBodyForEditor, wordCount } from '../src/lib/article-file.ts'
import { rendersSame } from '../src/lib/markdown.ts'

// The visual editor reads Markdown into a document and writes it back out.
// These run the same conversion without a browser.
const extensions = articleExtensions.filter((e) => e.name !== 'markdown')
const manager = new MarkdownManager({ extensions })
const schema = getSchema(extensions)
const roundTrip = (md: string) => manager.serialize(schema.nodeFromJSON(manager.parse(md)).toJSON())

test('every sample article opens in the visual editor without changing what readers see', () => {
  const dir = path.join(import.meta.dirname, '../examples/data')
  const files = ['public', 'private'].flatMap((v) =>
    fs.readdirSync(path.join(dir, v), { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.md')).map((f) => path.join(dir, v, f)),
  )
  assert.ok(files.length >= 5)
  for (const file of files) {
    const { body } = articleBodyForEditor(fs.readFileSync(file, 'utf8'), file)
    assert.ok(rendersSame(body, roundTrip(body)), `${path.basename(file)} would change`)
  }
})

test('formatting the editor offers survives the trip', () => {
  const body = [
    '## Heading',
    'Some **bold**, *italic*, ~~struck~~ and `code` with a [link](https://example.com).',
    '- one\n- two\n  - nested',
    '1. first\n2. second',
    '> A quote',
    '```js\nconst a = 1\n```',
    '---',
    '| A | B |\n| --- | --- |\n| 1 | 2 |',
    '![Alt text](https://example.com/a.png)',
  ].join('\n\n')
  assert.ok(rendersSame(body, roundTrip(body)))
})

test('content the editor can’t keep is detected, so it opens as Markdown instead', () => {
  for (const body of ['&copy; 2026 Example', '- [ ] To do\n- [x] Done']) {
    assert.equal(rendersSame(body, roundTrip(body)), false, body)
  }
})

test('rendersSame ignores formatting that doesn’t change the page', () => {
  // Raw HTML is shown as text on the help center, and stays text in the editor.
  assert.ok(rendersSame('<div>x</div>', roundTrip('<div>x</div>')))
  assert.ok(rendersSame('* a\n* b', '- a\n- b'))
  assert.ok(rendersSame('|a|b|\n|-|-|\n|1|2|', '| a | b |\n| --- | --- |\n| 1 | 2 |'))
  assert.equal(rendersSame('a *b*', 'a **b**'), false)
})

test('links: web, email and on-site only', () => {
  for (const ok of ['https://example.com/x?y=1', 'http://a.b', 'mailto:help@example.com', '/help/billing', '#setup']) assert.ok(isAllowedHref(ok), ok)
  for (const bad of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,x', '//evil.com', '/\\evil.com', 'vbscript:x', 'https://a b']) {
    assert.equal(isAllowedHref(bad), false, bad)
  }
  assert.equal(normalizeHref('example.com/docs'), 'https://example.com/docs')
  assert.equal(normalizeHref('help@example.com'), 'mailto:help@example.com')
  assert.equal(normalizeHref('  /help/x '), '/help/x')
  assert.equal(normalizeHref('javascript:alert(1)'), null)
  assert.equal(normalizeHref(''), null)
  assert.ok(isImageUrl('https://example.com/a.png'))
  for (const bad of ['http://example.com/a.png', 'data:image/png;base64,AAAA', 'javascript:x']) assert.equal(isImageUrl(bad), false, bad)
})

test('word count skips Markdown syntax and code', () => {
  assert.equal(wordCount('## Getting started\n\nOpen **Settings** and [click here](https://x.com).'), 7)
  assert.equal(wordCount('Run this:\n\n```sh\nnpm ci && npm run build\n```\n\n- done'), 3)
  assert.equal(wordCount(''), 0)
})
