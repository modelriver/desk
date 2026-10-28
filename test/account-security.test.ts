import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/server/db.server.ts'
import {
  clearCodeFailures,
  isLocked,
  LOCK_AFTER_FAILURES,
  recordCodeFailure,
  sessionUser,
} from '../src/server/account-security.server.ts'

const LATER = '2999-01-01T00:00:00.000Z'

function setup({ twoFactorOn }: { twoFactorOn: boolean }) {
  const db = openDb(':memory:')
  db.prepare(
    `INSERT INTO users (id, email, name, password_hash, role, created_at, totp_secret, totp_enabled_at)
     VALUES ('u1', 'a@example.test', 'A', 'x', 'admin', 'now', ?, ?)`,
  ).run(twoFactorOn ? 'SECRET' : null, twoFactorOn ? '2026-10-25T00:00:00Z' : null)
  const addSession = (hash: string, twoFactor: boolean) =>
    db.prepare('INSERT INTO auth_sessions (token_hash, user_id, expires_at, two_factor) VALUES (?, ?, ?, ?)').run(hash, 'u1', LATER, twoFactor ? 1 : 0)
  return { db, addSession }
}

test('a password-only session stops working once two-factor is back on', () => {
  const { db, addSession } = setup({ twoFactorOn: true })
  addSession('password-only', false)
  addSession('with-code', true)
  assert.equal(sessionUser(db, 'password-only', true)?.id, 'u1', 'fine while DISABLE_TWO_FACTOR is on')
  assert.equal(sessionUser(db, 'password-only', false), null, 'rejected once it is off')
  assert.equal(sessionUser(db, 'with-code', false)?.id, 'u1')
})

test('an account whose two-factor was reset has no valid sessions', () => {
  const { db, addSession } = setup({ twoFactorOn: false })
  addSession('with-code', true)
  assert.equal(sessionUser(db, 'with-code', false), null)
})

test('expired or unknown sessions are rejected', () => {
  const { db } = setup({ twoFactorOn: true })
  db.prepare("INSERT INTO auth_sessions (token_hash, user_id, expires_at, two_factor) VALUES ('old', 'u1', '2000-01-01T00:00:00Z', 1)").run()
  assert.equal(sessionUser(db, 'old', false), null)
  assert.equal(sessionUser(db, 'nope', false), null)
})

test('wrong codes lock the account after the limit, and survive until cleared', () => {
  const { db } = setup({ twoFactorOn: true })
  db.prepare("INSERT INTO login_challenges (token_hash, user_id, expires_at) VALUES ('c', 'u1', ?)").run(LATER)
  for (let i = 1; i < LOCK_AFTER_FAILURES; i++) assert.equal(recordCodeFailure(db, 'u1'), i)
  assert.equal(isLocked(db, 'u1'), false)
  assert.equal(recordCodeFailure(db, 'u1'), LOCK_AFTER_FAILURES)
  assert.equal(isLocked(db, 'u1'), true)
  const open = db.prepare("SELECT count(*) AS n FROM login_challenges WHERE user_id = 'u1'").get() as { n: number }
  assert.equal(open.n, 0, 'open sign-ins are cancelled')
  clearCodeFailures(db, 'u1')
  assert.equal(isLocked(db, 'u1'), false)
})
