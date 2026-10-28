import type { DatabaseSync } from 'node:sqlite'
import { getDb, now } from './db.server.ts'
import * as mr from './modelriver.server.ts'
import { describeConnectionError } from './status.server.ts'
import { TtlCache } from './ttl-cache.server.ts'

// Monthly usage comes from ModelRiver (GET /v1/usage), the same count it bills.
// The last numbers fetched for each month are kept in SQLite, so Settings still
// shows them, marked with when they were fetched, while ModelRiver can't be reached.

export interface MonthUsageView {
  month: string
  usage: mr.MonthUsage | null
  // When these numbers were fetched from ModelRiver.
  fetchedAt: string | null
  // Why the latest fetch failed, if it did.
  error: string | null
}

export const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/

export function currentMonth(at = new Date()): string {
  return at.toISOString().slice(0, 7)
}

// The month this install was set up (its first team account), so Settings
// doesn't offer months from before it existed.
export function setupMonth(db: DatabaseSync = getDb(), at = new Date()): string {
  const { first } = db.prepare('SELECT min(created_at) AS first FROM users').get() as { first: string | null }
  const created = first ? new Date(first) : null
  return created && !Number.isNaN(created.getTime()) ? currentMonth(created) : currentMonth(at)
}

// ModelRiver caches usage for a minute itself, so one fetch per month and minute is enough.
const cache = new TtlCache<MonthUsageView>(60_000, 100)

export function monthUsage(month: string, { refresh = false } = {}): Promise<MonthUsageView> {
  if (refresh) cache.delete(month)
  return cache.get(month, () => fetchMonthUsage(month))
}

// Never throws: a failed fetch falls back to the stored snapshot.
export async function fetchMonthUsage(month: string, db: DatabaseSync = getDb(), load = mr.getUsage): Promise<MonthUsageView> {
  try {
    const usage = await load(month)
    const fetchedAt = now()
    db.prepare(
      `INSERT INTO usage_snapshots (month, data, fetched_at) VALUES (?, ?, ?)
       ON CONFLICT (month) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at`,
    ).run(month, JSON.stringify(usage), fetchedAt)
    return { month, usage, fetchedAt, error: null }
  } catch (err) {
    const row = db.prepare('SELECT data, fetched_at FROM usage_snapshots WHERE month = ?').get(month) as
      | { data: string; fetched_at: string }
      | undefined
    return { month, usage: row ? JSON.parse(row.data) : null, fetchedAt: row?.fetched_at ?? null, error: describeUsageError(err) }
  }
}

export function describeUsageError(err: unknown): string {
  if (err instanceof mr.ModelRiverError && err.status === 404) {
    return 'This ModelRiver API doesn’t report usage yet (GET /v1/usage returned 404).'
  }
  return describeConnectionError(err).detail
}
