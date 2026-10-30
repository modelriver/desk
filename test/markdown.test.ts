import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderChatMarkdown, renderMarkdown } from '../src/lib/markdown.ts'

test('raw HTML is escaped, not rendered', () => {
  const html = renderMarkdown('Hi <script>alert(1)</script> <img src=x onerror=alert(1)>')
  assert.doesNotMatch(html, /<script>/)
  assert.doesNotMatch(html, /<img/)
  assert.match(html, /&lt;script&gt;/)
})

test('javascript: and data: links are not turned into links', () => {
  assert.doesNotMatch(renderMarkdown('[x](javascript:alert(1))'), /href="javascript/)
  assert.doesNotMatch(renderMarkdown('[x](data:text/html;base64,PHNjcmlwdD4=)'), /href="data:/)
})

test('external links open in a new tab without referrer; internal links stay plain', () => {
  const ext = renderMarkdown('[docs](https://example.com)')
  assert.match(ext, /target="_blank"/)
  assert.match(ext, /rel="noopener noreferrer nofollow"/)
  assert.doesNotMatch(renderMarkdown('[Billing](/articles/billing)'), /target=/)
})

test('chat text never renders images, only their alt text; articles still can', () => {
  const source = 'Look ![tracking pixel](https://evil.example/p.png?who=agent)'
  const chat = renderChatMarkdown(source)
  assert.doesNotMatch(chat, /<img/)
  assert.doesNotMatch(chat, /evil\.example/)
  assert.match(chat, /tracking pixel/)
  assert.match(renderMarkdown(source), /<img src="https:\/\/evil\.example/)
})
