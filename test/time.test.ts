import { test } from 'node:test'
import assert from 'node:assert/strict'
import { timeAgo } from '../src/lib/time.ts'

const base = Date.parse('2026-10-25T12:00:00Z')
const ago = (ms: number) => timeAgo(new Date(base - ms).toISOString(), base)
const S = 1000
const M = 60 * S
const H = 60 * M
const D = 24 * H

test('relative times are written out in full', () => {
  assert.equal(ago(0), 'just now')
  assert.equal(ago(9 * S), 'just now')
  assert.equal(ago(10 * S), '10 seconds ago')
  assert.equal(ago(59 * S), '59 seconds ago')
  assert.equal(ago(60 * S), '1 minute ago')
  assert.equal(ago(119 * S), '1 minute ago')
  assert.equal(ago(2 * M), '2 minutes ago')
  assert.equal(ago(59 * M), '59 minutes ago')
  assert.equal(ago(60 * M), '1 hour ago')
  assert.equal(ago(23 * H), '23 hours ago')
  assert.equal(ago(24 * H), 'yesterday')
  assert.equal(ago(2 * D), '2 days ago')
  assert.equal(ago(6 * D), '6 days ago')
  assert.equal(ago(10 * D), 'Oct 15, 2026')
})

test('timestamps slightly in the future read as just now; bad input is empty', () => {
  assert.equal(ago(-30 * S), 'just now')
  assert.equal(timeAgo('not a date', base), '')
})
