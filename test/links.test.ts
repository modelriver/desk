import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitLinks } from '../src/lib/links.ts'

test('web addresses in a message become links, without the sentence’s punctuation', () => {
  assert.deepEqual(splitLinks('See https://acme.com/orders?id=7&x=1. Thanks!'), [
    { text: 'See ' },
    { text: 'https://acme.com/orders?id=7&x=1', href: 'https://acme.com/orders?id=7&x=1' },
    { text: '. Thanks!' },
  ])
  assert.deepEqual(splitLinks('(http://a.test/x), "https://b.test"'), [
    { text: '(' },
    { text: 'http://a.test/x', href: 'http://a.test/x' },
    { text: '), "' },
    { text: 'https://b.test', href: 'https://b.test' },
    { text: '"' },
  ])
})

test('only http and https become links', () => {
  for (const text of ['javascript:alert(1)', 'data:text/html,hi', 'ftp://files.test/a', 'no links here', '']) {
    assert.ok(splitLinks(text).every((p) => !p.href), text)
  }
  assert.equal(splitLinks('Line one\nhttps://a.test\nline three').filter((p) => p.href).length, 1)
})
