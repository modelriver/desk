import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PAGE_SIZE, pageLinks, pageNumber, pageOf } from '../src/lib/paging.ts'

test('?page= is a whole number from 1; anything else is page 1', () => {
  assert.equal(pageNumber('3'), 3)
  assert.equal(pageNumber(2), 2)
  for (const bad of [undefined, '', '0', '-1', '2.5', 'abc', '9999999', null]) assert.equal(pageNumber(bad), 1, String(bad))
})

test('a page past the end shows the last one, and an empty list has one page', () => {
  assert.deepEqual(pageOf(0, 1), { page: 1, pages: 1, total: 0, pageSize: PAGE_SIZE, offset: 0 })
  assert.deepEqual(pageOf(60, 2), { page: 2, pages: 3, total: 60, pageSize: PAGE_SIZE, offset: PAGE_SIZE })
  // The last row on page 3 was archived: back to page 2.
  assert.equal(pageOf(50, 3).page, 2)
})

test('page links show the first, the last and the neighbours, with gaps', () => {
  assert.deepEqual(pageLinks(1, 1), [1])
  assert.deepEqual(pageLinks(1, 5), [1, 2, null, 5])
  assert.deepEqual(pageLinks(6, 12), [1, null, 5, 6, 7, null, 12])
  // A gap of one page shows that page instead of "…".
  assert.deepEqual(pageLinks(4, 5), [1, 2, 3, 4, 5])
})
