import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hashPassword, hashToken, newToken, verifyPassword } from '../src/server/password.server.ts'
import { openDb } from '../src/server/db.server.ts'

test('scrypt hashes verify only the right password', async () => {
  const stored = await hashPassword('correct horse battery')
  assert.match(stored, /^scrypt\$32768\$8\$1\$/)
  assert.equal(await verifyPassword('correct horse battery', stored), true)
  assert.equal(await verifyPassword('wrong password!', stored), false)
  assert.notEqual(await hashPassword('correct horse battery'), stored, 'salted')
})

test('malformed stored hashes never verify', async () => {
  assert.equal(await verifyPassword('x', 'plain-text'), false)
  assert.equal(await verifyPassword('x', 'scrypt$1$2$3'), false)
})

test('session tokens are random and stored as sha256', () => {
  const a = newToken()
  assert.notEqual(a, newToken())
  assert.equal(hashToken(a).length, 64)
  assert.equal(hashToken(a), hashToken(a))
})

test('database migrates and enforces roles and modes', () => {
  const db = openDb(':memory:')
  const insertUser = db.prepare(
    'INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
  insertUser.run('1', 'a@example.com', 'A', 'h', 'admin', 'now')
  assert.throws(() => insertUser.run('2', 'b@example.com', 'B', 'h', 'owner', 'now'))
  assert.throws(() => insertUser.run('3', 'A@EXAMPLE.COM', 'A', 'h', 'agent', 'now'), 'emails are case-insensitive unique')
  assert.throws(() =>
    db
      .prepare('INSERT INTO conversations (id, visitor_token_hash, mode, created_at, last_activity_at) VALUES (?, ?, ?, ?, ?)')
      .run('c', 'h', 'robot', 'now', 'now'),
  )
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>
  assert.deepEqual(
    tables.map((t) => t.name),
    [
      'admin_audit',
      'app_settings',
      'archived_sessions',
      'article_feedback',
      'articles',
      'auth_sessions',
      'connector_events',
      'connector_secrets',
      'connector_settings',
      'conversations',
      'knowledge_gaps',
      'login_challenges',
      'recovery_codes',
      'usage_snapshots',
      'user_avatars',
      'users',
      'visitor_codes',
    ],
  )
  assert.deepEqual({ ...(db.prepare('PRAGMA user_version').get() as object) }, { user_version: 19 })
  assert.throws(() =>
    db
      .prepare("INSERT INTO conversations (id, visitor_token_hash, mode, created_at, last_activity_at, verified_via) VALUES ('v', 'h', 'ai', 'now', 'now', 'guess')")
      .run(),
  )
  assert.throws(() => db.prepare("INSERT INTO connector_events (connector, subject_masked, status, created_at) VALUES ('stripe', 'x', 'maybe', 'now')").run())
  assert.throws(() => db.prepare("INSERT INTO connector_settings (connector, enabled, updated_at) VALUES ('stripe', 2, 'now')").run())
})

test('temporary passwords are long, readable and different each time', async () => {
  const { newTemporaryPassword } = await import('../src/server/password.server.ts')
  const a = newTemporaryPassword()
  assert.match(a, /^[a-hjkmnp-z2-9]{4}(-[a-hjkmnp-z2-9]{4}){3}$/)
  assert.notEqual(a, newTemporaryPassword())
})
