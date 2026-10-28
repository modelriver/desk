import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/server/db.server.ts'
import { ModelRiverError, type MonthUsage } from '../src/server/modelriver.server.ts'
import { currentMonth, fetchMonthUsage, MONTH_PATTERN, setupMonth } from '../src/server/usage.server.ts'

const october: MonthUsage = {
  project_id: 'p1',
  month: '2026-10',
  period_start: '2026-10-01T00:00:00Z',
  period_end: '2026-11-01T00:00:00Z',
  billable_requests: 3240,
  requests: 3301,
  failed_requests: 12,
  prompt_tokens: 100,
  completion_tokens: 50,
  total_tokens: 150,
  price: 12.48,
  active_sessions: 980,
  by_day: [{ date: '2026-10-01', billable_requests: 112, requests: 115 }],
  updated_at: '2026-10-27T09:14:00Z',
}

test('fetched usage is returned and kept for later', async () => {
  const db = openDb(':memory:')
  const view = await fetchMonthUsage('2026-10', db, async () => october)
  assert.equal(view.usage?.billable_requests, 3240)
  assert.equal(view.error, null)
  assert.ok(view.fetchedAt)
})

test('when ModelRiver can’t be reached, the last numbers are shown with the reason', async () => {
  const db = openDb(':memory:')
  const first = await fetchMonthUsage('2026-10', db, async () => october)
  const view = await fetchMonthUsage('2026-10', db, async () => {
    throw new TypeError('fetch failed')
  })
  assert.equal(view.usage?.billable_requests, 3240)
  assert.equal(view.fetchedAt, first.fetchedAt)
  assert.match(view.error!, /Couldn’t reach/)
})

test('a month never fetched has no numbers, only the reason', async () => {
  const db = openDb(':memory:')
  const view = await fetchMonthUsage('2026-09', db, async () => {
    throw new ModelRiverError('Not found', 404)
  })
  assert.equal(view.usage, null)
  assert.equal(view.fetchedAt, null)
  assert.match(view.error!, /doesn’t report usage yet/)
})

test('snapshots are per month', async () => {
  const db = openDb(':memory:')
  await fetchMonthUsage('2026-10', db, async () => october)
  const view = await fetchMonthUsage('2026-09', db, async () => {
    throw new ModelRiverError('Unauthorized', 401)
  })
  assert.equal(view.usage, null)
  assert.match(view.error!, /rejected the API key/)
})

test('months are YYYY-MM in UTC', () => {
  assert.equal(currentMonth(new Date('2026-10-31T23:30:00-05:00')), '2026-11')
  assert.ok(MONTH_PATTERN.test('2026-10'))
  for (const bad of ['2026-13', '2026-1', '26-10', '2026-10-01', '']) assert.ok(!MONTH_PATTERN.test(bad), bad)
})

test('usage starts from the month the first team account was created', () => {
  const db = openDb(':memory:')
  const now = new Date('2026-10-28T10:00:00Z')
  assert.equal(setupMonth(db, now), '2026-10', 'no accounts yet: this month')
  const insert = db.prepare('INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)')
  insert.run('2', 'b@example.com', 'B', 'h', 'agent', '2026-03-02T09:00:00.000Z')
  insert.run('1', 'a@example.com', 'A', 'h', 'admin', '2025-10-14T09:00:00.000Z')
  assert.equal(setupMonth(db, now), '2025-10')
})
