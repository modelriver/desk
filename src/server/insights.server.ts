import type { DatabaseSync } from 'node:sqlite'
import { getDb, now } from './db.server.ts'
import { tokenize } from '../lib/content-core.ts'

// What the help center is missing, for the team's Insights page:
// - questions it couldn't answer (nothing matched, the AI wasn't sure, or the AI failed)
// - how helpful visitors found each article
// Questions are kept for RETENTION_DAYS, then deleted by the hourly cleanup.

export type GapReason = 'no_match' | 'unsure' | 'ai_error'

export const RETENTION_DAYS = 90
const MAX_QUESTION = 300
const DAY = 86_400_000

// Questions that differ only in word order, case, punctuation or filler words
// group together: "How do I export?" and "export, how?" are the same gap.
export function normalizeQuestion(question: string): string {
  return [...new Set(tokenize(question))].sort().join(' ')
}

export function recordGap(
  input: { question: string; reason: GapReason; sessionId: string | null },
  db: DatabaseSync = getDb(),
): boolean {
  const question = input.question.replace(/\s+/g, ' ').trim().slice(0, MAX_QUESTION)
  const normalized = normalizeQuestion(question)
  if (!normalized) return false
  db.prepare('INSERT INTO knowledge_gaps (question, normalized, reason, session_id, created_at) VALUES (?, ?, ?, ?, ?)').run(
    question,
    normalized,
    input.reason,
    input.sessionId,
    now(),
  )
  return true
}

export interface GapGroup {
  normalized: string
  // The most recent wording, and how many times it was asked.
  question: string
  count: number
  reasons: GapReason[]
  lastAskedAt: string
  sessionId: string | null
}

// Open gaps from the last `days`, most asked first.
export function listGaps({ days = 30, limit = 50 } = {}, db: DatabaseSync = getDb()): GapGroup[] {
  const since = new Date(Date.now() - days * DAY).toISOString()
  const rows = db
    .prepare(
      `SELECT normalized, question, reason, session_id, created_at FROM knowledge_gaps
       WHERE dismissed_at IS NULL AND created_at >= ? ORDER BY created_at DESC, id DESC`,
    )
    .all(since) as Array<{ normalized: string; question: string; reason: GapReason; session_id: string | null; created_at: string }>
  const groups = new Map<string, GapGroup>()
  for (const r of rows) {
    const g = groups.get(r.normalized)
    if (g) {
      g.count++
      if (!g.reasons.includes(r.reason)) g.reasons.push(r.reason)
      continue
    }
    groups.set(r.normalized, {
      normalized: r.normalized,
      question: r.question,
      count: 1,
      reasons: [r.reason],
      lastAskedAt: r.created_at,
      sessionId: r.session_id,
    })
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || b.lastAskedAt.localeCompare(a.lastAskedAt)).slice(0, limit)
}

// "Handled": an article was written, or it isn't worth one. Hides every
// time this question was asked so far; asking again brings it back.
export function dismissGap(normalized: string, db: DatabaseSync = getDb()) {
  db.prepare('UPDATE knowledge_gaps SET dismissed_at = ? WHERE normalized = ? AND dismissed_at IS NULL').run(now(), normalized)
}

// --- Article feedback ---

// One vote per browser per article; voting again changes it.
export function recordVote(input: { slug: string; voter: string; helpful: boolean }, db: DatabaseSync = getDb()) {
  db.prepare(
    `INSERT INTO article_feedback (slug, voter, helpful, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (slug, voter) DO UPDATE SET helpful = excluded.helpful, created_at = excluded.created_at`,
  ).run(input.slug, input.voter, input.helpful ? 1 : 0, now())
}

export function voteOf(slug: string, voter: string, db: DatabaseSync = getDb()): boolean | null {
  const row = db.prepare('SELECT helpful FROM article_feedback WHERE slug = ? AND voter = ?').get(slug, voter) as
    | { helpful: number }
    | undefined
  return row ? row.helpful === 1 : null
}

export interface ArticleFeedback {
  slug: string
  title: string
  helpful: number
  notHelpful: number
}

// Per published article; least helpful first so the ones to fix lead.
export function feedbackSummary(db: DatabaseSync = getDb()): ArticleFeedback[] {
  const rows = db
    .prepare(
      `SELECT a.slug, a.title,
              coalesce(sum(f.helpful = 1), 0) AS helpful,
              coalesce(sum(f.helpful = 0), 0) AS notHelpful
       FROM articles a LEFT JOIN article_feedback f ON f.slug = a.slug
       GROUP BY a.slug, a.title`,
    )
    .all() as unknown as ArticleFeedback[]
  const share = (r: ArticleFeedback) => (r.helpful + r.notHelpful ? r.helpful / (r.helpful + r.notHelpful) : 1)
  return rows
    .map((r) => ({ ...r }))
    .sort((a, b) => share(a) - share(b) || b.notHelpful - a.notHelpful || a.title.localeCompare(b.title))
}

// Hourly: forget unanswered questions older than RETENTION_DAYS.
export function pruneInsights(at = Date.now(), db: DatabaseSync = getDb()): number {
  const cutoff = new Date(at - RETENTION_DAYS * DAY).toISOString()
  return Number(db.prepare('DELETE FROM knowledge_gaps WHERE created_at < ?').run(cutoff).changes)
}
