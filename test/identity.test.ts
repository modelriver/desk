import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { openDb } from '../src/server/db.server.ts'
import { archiveSession } from '../src/server/archive.server.ts'
import {
  clearVerification,
  confirmEmailCode,
  currentVerification,
  markVerified,
  VERIFIED_IDLE_MS,
  verificationStatus,
  IdentityError,
  issueEmailCode,
  normalizeEmail,
  signIdentityToken,
  verifyIdentityToken,
} from '../src/server/identity.server.ts'

const SECRET = 'identity-secret-identity-secret-123456'
const NOW = Date.parse('2026-10-28T12:00:00Z')
const NOW_S = NOW / 1000

function db() {
  const conn = openDb(':memory:')
  for (const id of ['c1', 'c2']) {
    conn
      .prepare(
        `INSERT INTO conversations (id, visitor_token_hash, visitor_name, modelriver_session_id, mode, created_at, last_activity_at)
         VALUES (?, 'h', 'Sam', ?, 'ai', 'now', 'now')`,
      )
      .run(id, `session-${id}`)
  }
  return conn
}

const verifiedRow = (conn: ReturnType<typeof db>, id = 'c1') =>
  ({ ...(conn.prepare('SELECT verified_email, verified_via FROM conversations WHERE id = ?').get(id) as object) }) as {
    verified_email: string | null
    verified_via: string | null
  }

const rejects = (fn: () => unknown, message: RegExp) =>
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof IdentityError, String(err))
    assert.match((err as Error).message, message)
    return true
  })

test('emails are lowercased and must be plain addresses', () => {
  assert.equal(normalizeEmail('  Sam@Example.COM '), 'sam@example.com')
  for (const bad of ['', 'sam', 'sam@', '@example.com', 'sam@example', 'sam"@example.com', 'sam @example.com', 'sam@exa mple.com', 'a@b.c"', `${'a'.repeat(65)}@example.com`, 42, null]) {
    assert.equal(normalizeEmail(bad), null, String(bad))
  }
})

test('the right code verifies the conversation, once', () => {
  const conn = db()
  const code = issueEmailCode(conn, 'c1', 'sam@example.com', NOW)
  assert.match(code, /^\d{6}$/)
  // Stored hashed.
  const row = conn.prepare('SELECT code_hash FROM visitor_codes WHERE conversation_id = ?').get('c1') as { code_hash: string }
  assert.ok(!row.code_hash.includes(code))
  assert.equal(confirmEmailCode(conn, 'c1', ` ${code.slice(0, 3)} ${code.slice(3)} `, NOW + 1000), 'sam@example.com')
  assert.deepEqual(verifiedRow(conn), { verified_email: 'sam@example.com', verified_via: 'email_code' })
  rejects(() => confirmEmailCode(conn, 'c1', code, NOW + 2000), /Ask for a code first/)
})

test('a code only works in the conversation that asked for it', () => {
  const conn = db()
  const code = issueEmailCode(conn, 'c1', 'sam@example.com', NOW)
  issueEmailCode(conn, 'c2', 'mallory@example.com', NOW)
  rejects(() => confirmEmailCode(conn, 'c2', code, NOW), /isn’t right/)
  assert.equal(verifiedRow(conn, 'c2').verified_email, null)
})

test('codes expire after 10 minutes', () => {
  const conn = db()
  const code = issueEmailCode(conn, 'c1', 'sam@example.com', NOW)
  rejects(() => confirmEmailCode(conn, 'c1', code, NOW + 10 * 60_000 + 1), /expired/)
  rejects(() => confirmEmailCode(conn, 'c1', code, NOW + 10 * 60_000 + 2), /Ask for a code first/)
})

test('five wrong codes lock verification for 15 minutes, even with a new code', () => {
  const conn = db()
  const code = issueEmailCode(conn, 'c1', 'sam@example.com', NOW)
  const wrong = code === '000000' ? '111111' : '000000'
  for (let left = 4; left >= 1; left--) rejects(() => confirmEmailCode(conn, 'c1', wrong, NOW), new RegExp(`${left} tr(y|ies) left`))
  rejects(() => confirmEmailCode(conn, 'c1', wrong, NOW), /Too many wrong codes. Try again in 15 minutes/)
  // Locked: even the right code fails, and asking for a new one doesn't reset it.
  rejects(() => confirmEmailCode(conn, 'c1', code, NOW + 60_000), /Too many wrong codes/)
  rejects(() => issueEmailCode(conn, 'c1', 'sam@example.com', NOW + 60_000), /Try again in 14 minutes/)
  // After the lock, a new code works.
  const fresh = issueEmailCode(conn, 'c1', 'sam@example.com', NOW + 16 * 60_000)
  assert.equal(confirmEmailCode(conn, 'c1', fresh, NOW + 16 * 60_000), 'sam@example.com')
})

test('codes must be six digits', () => {
  const conn = db()
  issueEmailCode(conn, 'c1', 'sam@example.com', NOW)
  rejects(() => confirmEmailCode(conn, 'c1', '12345', NOW), /6-digit/)
  rejects(() => confirmEmailCode(conn, 'c1', 'abcdef', NOW), /6-digit/)
  // Malformed input doesn't use up an attempt.
  const attempts = (conn.prepare('SELECT attempts FROM visitor_codes WHERE conversation_id = ?').get('c1') as { attempts: number }).attempts
  assert.equal(attempts, 0)
})

test('ending or archiving a conversation forgets who the visitor was', () => {
  const conn = db()
  confirmEmailCode(conn, 'c1', issueEmailCode(conn, 'c1', 'sam@example.com', NOW), NOW)
  clearVerification(conn, 'c1')
  assert.deepEqual(verifiedRow(conn), { verified_email: null, verified_via: null })

  confirmEmailCode(conn, 'c2', issueEmailCode(conn, 'c2', 'sam@example.com', NOW), NOW)
  issueEmailCode(conn, 'c2', 'sam@example.com', NOW)
  archiveSession('session-c2', 'Admin', conn)
  assert.deepEqual(verifiedRow(conn, 'c2'), { verified_email: null, verified_via: null })
  assert.equal(conn.prepare('SELECT count(*) AS n FROM visitor_codes').get()!.n, 0)
})

test('a signed identity token gives the email', () => {
  const token = signIdentityToken(SECRET, 'Sam@Example.com', NOW_S + 600)
  assert.equal(verifyIdentityToken(SECRET, token, NOW), 'sam@example.com')
})

test('identity tokens with a bad signature, a changed payload or another secret are refused', () => {
  const token = signIdentityToken(SECRET, 'sam@example.com', NOW_S + 600)
  const [payload, sig] = token.split('.') as [string, string]
  rejects(() => verifyIdentityToken('another-secret-another-secret-12345', token, NOW), /couldn’t confirm/)
  const forged = Buffer.from(JSON.stringify({ email: 'ceo@example.com', exp: NOW_S + 600 })).toString('base64url')
  rejects(() => verifyIdentityToken(SECRET, `${forged}.${sig}`, NOW), /couldn’t confirm/)
  rejects(() => verifyIdentityToken(SECRET, `${payload}.${sig.slice(0, -2)}AA`, NOW), /couldn’t confirm/)
  for (const bad of ['', 'abc', `${payload}.`, `.${sig}`, `${payload}.${sig}.extra`, 'x'.repeat(2000)]) {
    rejects(() => verifyIdentityToken(SECRET, bad, NOW), /couldn’t confirm/)
  }
  rejects(() => verifyIdentityToken('', token, NOW), /couldn’t confirm/)
})

test('identity tokens must be short-lived and hold exactly an email and an expiry', () => {
  rejects(() => verifyIdentityToken(SECRET, signIdentityToken(SECRET, 'sam@example.com', NOW_S - 1), NOW), /expired/)
  rejects(() => verifyIdentityToken(SECRET, signIdentityToken(SECRET, 'sam@example.com', NOW_S + 2 * 3600), NOW), /couldn’t confirm/)
  // Up to an hour (plus a minute of clock drift) is fine.
  assert.equal(verifyIdentityToken(SECRET, signIdentityToken(SECRET, 'sam@example.com', NOW_S + 3600 + 30), NOW), 'sam@example.com')
  rejects(() => verifyIdentityToken(SECRET, signIdentityToken(SECRET, 'not an email', NOW_S + 60), NOW), /couldn’t confirm/)
  // Correctly signed, so only the payload's shape is being tested.
  const sign = (obj: unknown) => {
    const payload = Buffer.from(JSON.stringify(obj)).toString('base64url')
    return `${payload}.${createHmac('sha256', SECRET).update(payload).digest('base64url')}`
  }
  rejects(() => verifyIdentityToken(SECRET, sign({ email: 'sam@example.com', exp: NOW_S + 60, admin: true }), NOW), /couldn’t confirm/)
  rejects(() => verifyIdentityToken(SECRET, sign({ email: 'sam@example.com', exp: String(NOW_S + 60) }), NOW), /couldn’t confirm/)
  rejects(() => verifyIdentityToken(SECRET, sign(['sam@example.com']), NOW), /couldn’t confirm/)
})

// --- How long a verification lasts ---

const HOUR = 3_600_000
const LIMITS = { maxMs: 24 * HOUR, idleMs: VERIFIED_IDLE_MS }
const at = (ms: number) => new Date(ms).toISOString()

test('a verification lasts until the total limit or two idle hours, whichever comes first', () => {
  const row = (verifiedAgo: number, activeAgo: number | null) => ({
    verified_email: 'sam@example.com',
    verified_at: at(NOW - verifiedAgo),
    verified_active_at: activeAgo === null ? null : at(NOW - activeAgo),
  })
  assert.deepEqual(verificationStatus({ verified_email: null, verified_at: null, verified_active_at: null }, NOW, LIMITS), { state: 'none' })
  assert.deepEqual(verificationStatus(row(HOUR, HOUR), NOW, LIMITS), { state: 'active', email: 'sam@example.com' })
  // Active a minute ago, but verified 24 hours ago: the total limit wins.
  assert.deepEqual(verificationStatus(row(24 * HOUR, 60_000), NOW, LIMITS), { state: 'expired' })
  assert.deepEqual(verificationStatus(row(24 * HOUR - 60_000, 60_000), NOW, LIMITS).state, 'active')
  // Verified recently, but nothing for two hours.
  assert.deepEqual(verificationStatus(row(3 * HOUR, 2 * HOUR), NOW, LIMITS), { state: 'expired' })
  assert.deepEqual(verificationStatus(row(3 * HOUR, 2 * HOUR - 60_000), NOW, LIMITS).state, 'active')
  // Verified before activity was tracked: idle time counts from the verification.
  assert.deepEqual(verificationStatus(row(2 * HOUR, null), NOW, LIMITS), { state: 'expired' })
  assert.deepEqual(verificationStatus(row(HOUR, null), NOW, LIMITS).state, 'active')
  // VERIFIED_HOURS=0: no total limit, the idle limit still applies.
  assert.deepEqual(verificationStatus(row(30 * 24 * HOUR, 60_000), NOW, { ...LIMITS, maxMs: 0 }).state, 'active')
  assert.deepEqual(verificationStatus(row(30 * 24 * HOUR, 3 * HOUR), NOW, { ...LIMITS, maxMs: 0 }).state, 'expired')
  assert.deepEqual(verificationStatus({ ...row(HOUR, HOUR), verified_at: 'garbage' }, NOW, LIMITS), { state: 'expired' })
})

test('messages from the visitor keep a verification alive; reloads don’t', () => {
  const conn = db()
  markVerified(conn, 'c1', 'sam@example.com', 'email_code')
  const verifiedAt = Date.now()
  // A message every 90 minutes keeps it going...
  for (let i = 1; i <= 4; i++) {
    assert.deepEqual(currentVerification(conn, 'c1', { touch: true, nowMs: verifiedAt + i * 90 * 60_000, limits: LIMITS }), {
      email: 'sam@example.com',
      expired: false,
    })
  }
  // ...but reloads alone don't count: two hours after the last message it has lapsed.
  const lastMessage = verifiedAt + 4 * 90 * 60_000
  assert.equal(currentVerification(conn, 'c1', { touch: false, nowMs: lastMessage + HOUR, limits: LIMITS }).email, 'sam@example.com')
  assert.deepEqual(currentVerification(conn, 'c1', { touch: false, nowMs: lastMessage + 2 * HOUR, limits: LIMITS }), { email: null, expired: true })
})

test('a lapsed verification is cleared by the next message, and stays gone', () => {
  const conn = db()
  markVerified(conn, 'c1', 'sam@example.com', 'identity_token')
  const later = Date.now() + 25 * HOUR
  // A reload reports it but leaves it, so the next message can say it expired.
  assert.deepEqual(currentVerification(conn, 'c1', { touch: false, nowMs: later, limits: LIMITS }), { email: null, expired: true })
  assert.equal(verifiedRow(conn).verified_email, 'sam@example.com')
  assert.deepEqual(currentVerification(conn, 'c1', { touch: true, nowMs: later, limits: LIMITS }), { email: null, expired: true })
  assert.deepEqual(verifiedRow(conn), { verified_email: null, verified_via: null })
  // Nothing to bring back: later checks see no verification at all.
  assert.deepEqual(currentVerification(conn, 'c1', { touch: true, nowMs: later + 1000, limits: LIMITS }), { email: null, expired: false })
})

test('verifying again starts the clock again', () => {
  const conn = db()
  markVerified(conn, 'c1', 'old@example.com', 'email_code')
  // Lapsed and cleared by a message a day later...
  currentVerification(conn, 'c1', { touch: true, nowMs: Date.now() + 25 * HOUR, limits: LIMITS })
  // ...then the visitor verifies again (now), and it counts from then.
  confirmEmailCode(conn, 'c1', issueEmailCode(conn, 'c1', 'sam@example.com'))
  assert.deepEqual(currentVerification(conn, 'c1', { touch: true, nowMs: Date.now() + HOUR, limits: LIMITS }), {
    email: 'sam@example.com',
    expired: false,
  })
})
