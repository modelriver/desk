import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/server/db.server.ts'
import {
  dismissGap,
  feedbackSummary,
  listGaps,
  normalizeQuestion,
  pruneInsights,
  recordGap,
  recordVote,
  RETENTION_DAYS,
  voteOf,
} from '../src/server/insights.server.ts'

const DAY = 86_400_000

test('questions that differ only in order, case or filler words group together', () => {
  assert.equal(normalizeQuestion('How do I export my notes?'), normalizeQuestion('notes EXPORT, how'))
  assert.notEqual(normalizeQuestion('export notes'), normalizeQuestion('import notes'))
  assert.equal(normalizeQuestion('how do I?'), '')
})

test('unanswered questions are grouped, counted and listed most asked first', () => {
  const db = openDb(':memory:')
  recordGap({ question: 'Can I export to Word?', reason: 'unsure', sessionId: 's1' }, db)
  recordGap({ question: 'export to word, can I', reason: 'no_match', sessionId: 's2' }, db)
  recordGap({ question: 'Do you have an API?', reason: 'unsure', sessionId: null }, db)
  assert.equal(recordGap({ question: 'how do I?', reason: 'unsure', sessionId: null }, db), false, 'nothing meaningful to keep')

  const gaps = listGaps({}, db)
  assert.equal(gaps.length, 2)
  assert.equal(gaps[0]!.count, 2)
  assert.deepEqual(gaps[0]!.reasons.sort(), ['no_match', 'unsure'])
  assert.equal(gaps[0]!.question, 'export to word, can I', 'shows the latest wording')
  assert.equal(gaps[0]!.sessionId, 's2')
})

test('two wordings asked in the same millisecond show the one saved last', () => {
  const db = openDb(':memory:')
  const at = new Date().toISOString()
  const insert = db.prepare('INSERT INTO knowledge_gaps (question, normalized, reason, session_id, created_at) VALUES (?, ?, ?, ?, ?)')
  const asked: Array<[string, string]> = [
    ['Can I export to Word?', 's1'],
    ['export to word, can I', 's2'],
  ]
  for (const [question, sessionId] of asked) insert.run(question, normalizeQuestion(question), 'unsure', sessionId, at)
  const [gap] = listGaps({}, db)
  assert.equal(gap!.count, 2)
  assert.equal(gap!.question, 'export to word, can I')
  assert.equal(gap!.sessionId, 's2')
})

test('marking a question handled hides it until someone asks again', () => {
  const db = openDb(':memory:')
  recordGap({ question: 'Do you have an API?', reason: 'unsure', sessionId: null }, db)
  dismissGap(normalizeQuestion('Do you have an API?'), db)
  assert.equal(listGaps({}, db).length, 0)
  recordGap({ question: 'API available?', reason: 'unsure', sessionId: null }, db)
  assert.equal(listGaps({}, db)[0]!.count, 1)
})

test('long questions are trimmed and old ones are forgotten after the retention period', () => {
  const db = openDb(':memory:')
  recordGap({ question: `export ${'x'.repeat(1000)}`, reason: 'unsure', sessionId: null }, db)
  const row = db.prepare('SELECT length(question) AS n FROM knowledge_gaps').get() as { n: number }
  assert.equal(row.n, 300)
  assert.equal(pruneInsights(Date.now() + (RETENTION_DAYS - 1) * DAY, db), 0)
  assert.equal(pruneInsights(Date.now() + (RETENTION_DAYS + 1) * DAY, db), 1)
})

test('one vote per browser per article, which can be changed; least helpful articles lead', () => {
  const db = openDb(':memory:')
  const add = db.prepare("INSERT INTO articles (slug, title, description, file, updated_at) VALUES (?, ?, '', ?, 'now')")
  add.run('good', 'Good article', 'good.md')
  add.run('weak', 'Weak article', 'weak.md')
  add.run('unrated', 'Unrated article', 'unrated.md')

  recordVote({ slug: 'good', voter: 'a', helpful: true }, db)
  recordVote({ slug: 'good', voter: 'b', helpful: true }, db)
  recordVote({ slug: 'weak', voter: 'a', helpful: true }, db)
  recordVote({ slug: 'weak', voter: 'a', helpful: false }, db)
  recordVote({ slug: 'weak', voter: 'c', helpful: false }, db)
  assert.equal(voteOf('weak', 'a', db), false, 'changed, not counted twice')
  assert.equal(voteOf('weak', 'z', db), null)

  const summary = feedbackSummary(db)
  assert.deepEqual(
    summary.map((s) => [s.slug, s.helpful, s.notHelpful]),
    [
      ['weak', 0, 2],
      ['good', 2, 0],
      ['unrated', 0, 0],
    ],
  )
})
