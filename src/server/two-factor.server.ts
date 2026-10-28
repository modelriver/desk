import { deleteCookie, getCookie, setCookie } from '@tanstack/react-start/server'
import { getDb, now } from './db.server.ts'
import { env } from './env.server.ts'
import { AuthError, clientIp, createSession } from './auth.server.ts'
import { allowAll } from './rate-limit.server.ts'
import { hashToken, newToken } from './password.server.ts'
import { clearCodeFailures, isLocked, LOCK_AFTER_FAILURES, LOCKED_MESSAGE, recordCodeFailure } from './account-security.server.ts'
import { hashRecoveryCode, newRecoveryCodes, newTotpSecret, normalizeRecoveryCode, verifyTotp } from './totp.server.ts'

// Step 2 of sign-in. After a correct password the browser holds a short-lived
// HttpOnly challenge cookie; a real session is only created once a valid
// authenticator code (or recovery code) is entered. Accounts without 2FA must
// set it up here before they get a session.

const CHALLENGE_COOKIE = 'desk_2fa'
const CHALLENGE_MINUTES = 10
const MAX_ATTEMPTS = 5

type Challenge = { token_hash: string; user_id: string; pending_secret: string | null; attempts: number }

export function startChallenge(userId: string, needsSetup: boolean): { secret: string | null } {
  const db = getDb()
  // One open sign-in per account; stale ones are cleaned up as we go.
  db.prepare('DELETE FROM login_challenges WHERE user_id = ? OR expires_at <= ?').run(userId, now())
  const token = newToken()
  const secret = needsSetup ? newTotpSecret() : null
  const expires = new Date(Date.now() + CHALLENGE_MINUTES * 60_000)
  db.prepare('INSERT INTO login_challenges (token_hash, user_id, pending_secret, expires_at) VALUES (?, ?, ?, ?)').run(
    hashToken(token),
    userId,
    secret,
    expires.toISOString(),
  )
  setCookie(CHALLENGE_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: env.production, path: '/', expires })
  return { secret }
}

function currentChallenge(): Challenge {
  const token = getCookie(CHALLENGE_COOKIE)
  const row = token
    ? (getDb()
        .prepare('SELECT token_hash, user_id, pending_secret, attempts FROM login_challenges WHERE token_hash = ? AND expires_at > ?')
        .get(hashToken(token), now()) as Challenge | undefined)
    : undefined
  if (!row) throw new AuthError('Your sign-in expired. Enter your email and password again.')
  return row
}

function endChallenge(challenge: Challenge) {
  getDb().prepare('DELETE FROM login_challenges WHERE token_hash = ?').run(challenge.token_hash)
  deleteCookie(CHALLENGE_COOKIE, { path: '/' })
}

// Counts a wrong code. After MAX_ATTEMPTS the sign-in is cancelled, so the
// password has to be entered again (and its own rate limits apply). Wrong
// sign-in codes also count towards the account's lasting lockout.
function failAttempt(challenge: Challenge, { signIn = false } = {}): never {
  if (signIn && recordCodeFailure(getDb(), challenge.user_id) >= LOCK_AFTER_FAILURES) {
    deleteCookie(CHALLENGE_COOKIE, { path: '/' })
    throw new AuthError(LOCKED_MESSAGE)
  }
  const attempts = challenge.attempts + 1
  if (attempts >= MAX_ATTEMPTS) {
    endChallenge(challenge)
    throw new AuthError('Too many wrong codes. Enter your email and password again.')
  }
  getDb().prepare('UPDATE login_challenges SET attempts = ? WHERE token_hash = ?').run(attempts, challenge.token_hash)
  throw new AuthError(`That code didn’t work. ${MAX_ATTEMPTS - attempts} ${MAX_ATTEMPTS - attempts === 1 ? 'try' : 'tries'} left.`)
}

function limitCodeAttempts(userId: string) {
  const window = 15 * 60_000
  const allowed = allowAll([
    { key: `2fa-ip:${clientIp()}`, max: 30, windowMs: window },
    { key: `2fa-account:${userId}`, max: 20, windowMs: window },
  ])
  if (!allowed) throw new AuthError('Too many attempts. Try again in a few minutes.')
}

// Sign in with an authenticator code or a one-time recovery code.
export function verifySignInCode(input: string): { usedRecoveryCode: boolean; recoveryCodesLeft: number } {
  const challenge = currentChallenge()
  if (challenge.pending_secret) throw new AuthError('Finish setting up two-factor authentication first.')
  const db = getDb()
  if (isLocked(db, challenge.user_id)) throw new AuthError(LOCKED_MESSAGE)
  limitCodeAttempts(challenge.user_id)
  const user = db.prepare('SELECT totp_secret, totp_last_step FROM users WHERE id = ?').get(challenge.user_id) as
    | { totp_secret: string | null; totp_last_step: number | null }
    | undefined
  if (!user?.totp_secret) throw new AuthError('Two-factor authentication was reset. Enter your email and password again.')

  let usedRecoveryCode = false
  const step = verifyTotp(user.totp_secret, input, user.totp_last_step)
  if (step !== null) {
    db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(step, challenge.user_id)
  } else if (normalizeRecoveryCode(input)) {
    const used = db
      .prepare('UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL')
      .run(now(), challenge.user_id, hashRecoveryCode(input))
    if (used.changes !== 1) failAttempt(challenge, { signIn: true })
    usedRecoveryCode = true
  } else {
    failAttempt(challenge, { signIn: true })
  }

  clearCodeFailures(db, challenge.user_id)
  endChallenge(challenge)
  createSession(challenge.user_id, { twoFactor: true })
  const left = db.prepare('SELECT count(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL').get(challenge.user_id) as {
    n: number
  }
  return { usedRecoveryCode, recoveryCodesLeft: left.n }
}

// First sign-in (or after a reset): confirm the authenticator app works, turn
// 2FA on, and hand out recovery codes. They're shown once and stored hashed.
export function completeSetup(input: string): { recoveryCodes: string[] } {
  const challenge = currentChallenge()
  if (!challenge.pending_secret) throw new AuthError('Two-factor authentication is already set up.')
  limitCodeAttempts(challenge.user_id)
  const step = verifyTotp(challenge.pending_secret, input, null)
  if (step === null) failAttempt(challenge)

  const db = getDb()
  const codes = newRecoveryCodes()
  db.exec('BEGIN')
  try {
    db.prepare('UPDATE users SET totp_secret = ?, totp_enabled_at = ?, totp_last_step = ? WHERE id = ?').run(
      challenge.pending_secret,
      now(),
      step,
      challenge.user_id,
    )
    db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(challenge.user_id)
    const insert = db.prepare('INSERT INTO recovery_codes (code_hash, user_id) VALUES (?, ?)')
    for (const code of codes) insert.run(hashRecoveryCode(code), challenge.user_id)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  clearCodeFailures(db, challenge.user_id)
  endChallenge(challenge)
  createSession(challenge.user_id, { twoFactor: true })
  return { recoveryCodes: codes }
}

// Admin reset (lost phone and recovery codes): turns 2FA off and signs the
// person out everywhere. They set it up again at their next sign-in.
export function resetTwoFactor(userId: string) {
  const db = getDb()
  db.exec('BEGIN')
  try {
    db.prepare(
      'UPDATE users SET totp_secret = NULL, totp_enabled_at = NULL, totp_last_step = NULL, totp_failures = 0 WHERE id = ?',
    ).run(userId)
    db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(userId)
    db.prepare('DELETE FROM login_challenges WHERE user_id = ?').run(userId)
    db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(userId)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}
