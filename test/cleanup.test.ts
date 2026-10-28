import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/server/db.server.ts'
import { pruneExpired } from '../src/server/archive.server.ts'

const PAST = '2000-01-01T00:00:00.000Z'
const FUTURE = '2999-01-01T00:00:00.000Z'

test('expired sign-ins and email codes are removed, live ones and running lockouts stay', () => {
  const db = openDb(':memory:')
  db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('u1', 'sam@example.test', 'Sam', 'x', 'agent', 'now')").run()
  for (const [id, expires] of [['c-old', PAST], ['c-live', FUTURE], ['c-locked', PAST]] as const) {
    db.prepare(
      "INSERT INTO conversations (id, visitor_token_hash, visitor_name, mode, created_at, last_activity_at) VALUES (?, ?, 'Jack', 'ai', 'now', 'now')",
    ).run(id, `hash-${id}`)
    db.prepare("INSERT INTO visitor_codes (conversation_id, email, code_hash, expires_at, attempts, locked_until) VALUES (?, 'jack@example.test', 'h', ?, 0, ?)").run(
      id,
      expires,
      id === 'c-locked' ? FUTURE : null,
    )
  }
  db.prepare("INSERT INTO auth_sessions (token_hash, user_id, expires_at, two_factor) VALUES ('s-old', 'u1', ?, 1)").run(PAST)
  db.prepare("INSERT INTO auth_sessions (token_hash, user_id, expires_at, two_factor) VALUES ('s-live', 'u1', ?, 1)").run(FUTURE)
  db.prepare("INSERT INTO login_challenges (token_hash, user_id, expires_at) VALUES ('l-old', 'u1', ?)").run(PAST)

  assert.equal(pruneExpired(db), 3)

  const ids = (sql: string) => (db.prepare(sql).all() as { id: string }[]).map((r) => r.id).sort()
  assert.deepEqual(ids('SELECT token_hash AS id FROM auth_sessions'), ['s-live'])
  assert.deepEqual(ids('SELECT token_hash AS id FROM login_challenges'), [])
  assert.deepEqual(ids('SELECT conversation_id AS id FROM visitor_codes'), ['c-live', 'c-locked'])
})
