import type { DatabaseSync } from 'node:sqlite'
import { getDb, now } from './db.server.ts'
import * as mr from './modelriver.server.ts'
import { describeConnectionError } from './status.server.ts'
import { TtlCache } from './ttl-cache.server.ts'

// Usage comes from ModelRiver (GET /v1/usage), the same count it bills: per
// calendar month, or per monthly credit cycle when ModelRiver has a quota for
// this install's project. The last numbers fetched for each period are kept in
// SQLite, so Settings still shows them, marked with when they were fetched,
// while ModelRiver can't be reached.

interface Fetched<T> {
  usage: T | null
  // When these numbers were fetched from ModelRiver.
  fetchedAt: string | null
  // Why the latest fetch failed, if it did.
  error: string | null
}

export interface MonthUsageView extends Fetched<mr.MonthUsage> {
  kind: 'month'
  month: string
}

export interface CycleUsageView extends Fetched<mr.CycleUsage> {
  kind: 'cycle'
  // "current", or a date inside an earlier cycle (YYYY-MM-DD).
  cycle: string
}

export type UsageView = MonthUsageView | CycleUsageView

export const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/
export const CYCLE_PATTERN = /^(current|\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01]))$/

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

// Whether ModelRiver caps this install's project with a monthly quota.
export function hasQuota(usage: { quota?: number | null } | null): usage is mr.CycleUsage & { quota: number } {
  return typeof usage?.quota === 'number'
}

// ModelRiver caches usage for a minute itself, so one fetch per period and minute is enough.
const cache = new TtlCache<UsageView>(60_000, 100)

export function monthUsage(month: string, { refresh = false } = {}): Promise<MonthUsageView> {
  if (refresh) cache.delete(month)
  return cache.get(month, () => fetchMonthUsage(month)) as Promise<MonthUsageView>
}

export function cycleUsage(cycle: string, { refresh = false } = {}): Promise<CycleUsageView> {
  const key = `cycle:${cycle}`
  if (refresh) cache.delete(key)
  return cache.get(key, () => fetchCycleUsage(cycle)) as Promise<CycleUsageView>
}

// What Settings opens on: the current credit cycle when there's a quota,
// otherwise the current calendar month.
export async function currentUsage(): Promise<UsageView> {
  const cycle = await cycleUsage('current')
  return hasQuota(cycle.usage) ? cycle : monthUsage(currentMonth())
}

// Never throws: a failed fetch falls back to the stored snapshot.
export async function fetchMonthUsage(month: string, db: DatabaseSync = getDb(), load = mr.getUsage): Promise<MonthUsageView> {
  return { kind: 'month', month, ...(await fetchSnapshot(month, () => load(month), db)) }
}

// A ModelRiver without cycles answers with the current month. That has no
// quota, so currentUsage shows the month instead.
export async function fetchCycleUsage(cycle: string, db: DatabaseSync = getDb(), load = mr.getCycleUsage): Promise<CycleUsageView> {
  const fetched = await fetchSnapshot(`cycle:${cycle}`, () => load(cycle), db)
  return { kind: 'cycle', cycle, ...(fetched as Fetched<mr.CycleUsage>) }
}

// Snapshots are keyed by month (YYYY-MM) or by cycle (cycle:current, cycle:YYYY-MM-DD).
async function fetchSnapshot<T>(key: string, load: () => Promise<T>, db: DatabaseSync): Promise<Fetched<T>> {
  try {
    const usage = await load()
    const fetchedAt = now()
    db.prepare(
      `INSERT INTO usage_snapshots (month, data, fetched_at) VALUES (?, ?, ?)
       ON CONFLICT (month) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at`,
    ).run(key, JSON.stringify(usage), fetchedAt)
    return { usage, fetchedAt, error: null }
  } catch (err) {
    const row = db.prepare('SELECT data, fetched_at FROM usage_snapshots WHERE month = ?').get(key) as
      | { data: string; fetched_at: string }
      | undefined
    return { usage: row ? JSON.parse(row.data) : null, fetchedAt: row?.fetched_at ?? null, error: describeUsageError(err) }
  }
}

export function describeUsageError(err: unknown): string {
  if (err instanceof mr.ModelRiverError && err.status === 404) {
    return 'This ModelRiver API doesn’t report usage yet (GET /v1/usage returned 404).'
  }
  return describeConnectionError(err).detail
}
