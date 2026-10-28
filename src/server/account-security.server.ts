import type { DatabaseSync } from 'node:sqlite'
import { now } from './db.server.ts'

// Session and lockout rules, kept free of request handling so they can be tested directly.

export interface SessionUser {
  id: string
  email: string
  name: string
  role: 'admin' | 'agent'
}

// The account behind a session token, or null. With two-factor on, the
// session must have passed the code step and the account must still have 2FA
// set up: password-only sessions made while DISABLE_TWO_FACTOR was on stop
// working once it's turned off, and an admin reset ends every session.
export function sessionUser(db: DatabaseSync, tokenHash: string, twoFactorDisabled: boolean): SessionUser | null {
  const row = db
    .prepare(
      `SELECT u.id, u.email, u.name, u.role FROM auth_sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ? AND (? OR (s.two_factor = 1 AND u.totp_enabled_at IS NOT NULL))`,
    )
    .get(tokenHash, now(), twoFactorDisabled ? 1 : 0) as SessionUser | undefined
  return row ? { ...row } : null
}

// Wrong sign-in codes are also limited per 15 minutes in memory; this count
// is stored, survives restarts and never resets on its own. Reaching it locks
// the account until an admin resets its two-factor (or `npm run create-admin`).
// 30 guesses against a 6-digit code (3 valid at a time) is about a 1 in 11,000 chance.
export const LOCK_AFTER_FAILURES = 30

export const LOCKED_MESSAGE =
  'This account is locked after too many wrong codes. Ask an admin to reset its two-factor authentication, and change the password: someone may know it.'

export function isLocked(db: DatabaseSync, userId: string): boolean {
  const row = db.prepare('SELECT totp_failures FROM users WHERE id = ?').get(userId) as { totp_failures: number } | undefined
  return (row?.totp_failures ?? 0) >= LOCK_AFTER_FAILURES
}

// Returns the new count. Locking also ends the account's open sign-ins.
export function recordCodeFailure(db: DatabaseSync, userId: string): number {
  db.prepare('UPDATE users SET totp_failures = totp_failures + 1 WHERE id = ?').run(userId)
  const row = db.prepare('SELECT totp_failures FROM users WHERE id = ?').get(userId) as { totp_failures: number }
  if (row.totp_failures >= LOCK_AFTER_FAILURES) {
    db.prepare('DELETE FROM login_challenges WHERE user_id = ?').run(userId)
  }
  return row.totp_failures
}

export function clearCodeFailures(db: DatabaseSync, userId: string) {
  db.prepare('UPDATE users SET totp_failures = 0 WHERE id = ?').run(userId)
}
