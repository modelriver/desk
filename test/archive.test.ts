import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/server/db.server.ts'
import { archivedSessions, archiveSession, cleanupArchived, deleteAt, restoreSession } from '../src/server/archive.server.ts'
import { ModelRiverError } from '../src/server/modelriver.server.ts'
import { timeUntil } from '../src/lib/time.ts'

const HOUR = 3_600_000
const SESSION = '11111111-1111-4111-8111-111111111111'

function dbWithConversation() {
  const db = openDb(':memory:')
  db.prepare(
    `INSERT INTO conversations (id, visitor_token_hash, visitor_name, modelriver_session_id, mode, created_at, last_activity_at, handoff_requested_at)
     VALUES ('c1', 'hash', 'Jack', ?, 'human', '2026-10-25T00:00:00Z', '2026-10-25T00:00:00Z', '2026-10-25T00:00:00Z')`,
  ).run(SESSION)
  return db
}

// The session belongs to this app's workflow.
const sameWorkflow = { workflow: 'support_assistant', getWorkflow: async () => 'support_assistant' }

const row = (db: ReturnType<typeof openDb>) =>
  db.prepare('SELECT ended_at, handoff_requested_at FROM conversations WHERE id = ?').get('c1') as
    | { ended_at: string | null; handoff_requested_at: string | null }
    | undefined

test('archiving ends the conversation and clears a pending request for a person', () => {
  const db = dbWithConversation()
  archiveSession(SESSION, 'Dev Admin', db)
  assert.ok(archivedSessions(db).has(SESSION))
  assert.ok(row(db)!.ended_at, 'ended')
  assert.equal(row(db)!.handoff_requested_at, null)
  // Archiving twice keeps the first time, so the deletion clock doesn't restart.
  const first = archivedSessions(db).get(SESSION)
  archiveSession(SESSION, 'Someone else', db)
  assert.equal(archivedSessions(db).get(SESSION), first)
})

test('restoring takes it out of the archive, but the conversation stays ended', () => {
  const db = dbWithConversation()
  archiveSession(SESSION, 'Dev Admin', db)
  restoreSession(SESSION, db)
  assert.equal(archivedSessions(db).size, 0)
  assert.ok(row(db)!.ended_at)
})

test('cleanup deletes only conversations archived longer than the retention period', async () => {
  const db = dbWithConversation()
  archiveSession(SESSION, 'Dev Admin', db)
  const archivedAt = Date.parse(archivedSessions(db).get(SESSION)!)
  const deleted: string[] = []
  const deleteSession = async (id: string) => void deleted.push(id)

  assert.equal(await cleanupArchived({ db, ...sameWorkflow, retentionHours: 24, at: archivedAt + 23 * HOUR, deleteSession }), 0)
  assert.deepEqual(deleted, [])

  assert.equal(await cleanupArchived({ db, ...sameWorkflow, retentionHours: 24, at: archivedAt + 24 * HOUR, deleteSession }), 1)
  assert.deepEqual(deleted, [SESSION])
  assert.equal(archivedSessions(db).size, 0)
  assert.equal(row(db), undefined, 'local row removed too')
})

test('a session already gone in ModelRiver counts as deleted; other failures are retried', async () => {
  const db = dbWithConversation()
  archiveSession(SESSION, 'Dev Admin', db)
  const later = Date.parse(archivedSessions(db).get(SESSION)!) + 48 * HOUR

  const down = async () => {
    throw new ModelRiverError('Service unavailable', 503)
  }
  assert.equal(await cleanupArchived({ db, ...sameWorkflow, retentionHours: 24, at: later, deleteSession: down }), 0)
  assert.ok(archivedSessions(db).has(SESSION), 'kept for the next run')

  const gone = async () => {
    throw new ModelRiverError('Session not found', 404)
  }
  assert.equal(await cleanupArchived({ db, ...sameWorkflow, retentionHours: 24, at: later, deleteSession: gone }), 1)
  assert.equal(archivedSessions(db).size, 0)
})

test('cleanup never deletes a session from another workflow', async () => {
  const db = dbWithConversation()
  archiveSession(SESSION, 'Dev Admin', db)
  const later = Date.parse(archivedSessions(db).get(SESSION)!) + 48 * HOUR
  const never = async () => assert.fail('must not delete another workflow’s session')
  const n = await cleanupArchived({
    db,
    workflow: 'support_assistant',
    getWorkflow: async () => 'billing_bot',
    retentionHours: 24,
    at: later,
    deleteSession: never,
  })
  assert.equal(n, 0)
  assert.equal(archivedSessions(db).size, 0, 'taken out of the archive instead')
})

test('retention 0 keeps everything', async () => {
  const db = dbWithConversation()
  archiveSession(SESSION, 'Dev Admin', db)
  const never = async () => assert.fail('should not delete')
  assert.equal(await cleanupArchived({ db, ...sameWorkflow, retentionHours: 0, at: Date.now() + 1000 * HOUR, deleteSession: never }), 0)
  assert.equal(deleteAt('2026-10-25T00:00:00.000Z', 0), null)
  assert.equal(deleteAt('2026-10-25T00:00:00.000Z', 24), '2026-10-26T00:00:00.000Z')
})

test('times ahead read naturally', () => {
  const now = Date.parse('2026-10-25T00:00:00Z')
  const at = (ms: number) => new Date(now + ms).toISOString()
  assert.equal(timeUntil(at(30_000), now), 'soon')
  assert.equal(timeUntil(at(-HOUR), now), 'soon')
  assert.equal(timeUntil(at(45 * 60_000), now), 'in 45 minutes')
  assert.equal(timeUntil(at(HOUR), now), 'in 1 hour')
  assert.equal(timeUntil(at(21 * HOUR + 5 * 60_000), now), 'in 21 hours')
  assert.equal(timeUntil(at(72 * HOUR), now), 'in 3 days')
  assert.equal(timeUntil(at(24 * HOUR - 60_000), now), 'in 24 hours')
})
