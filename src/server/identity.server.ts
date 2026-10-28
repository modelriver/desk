import { createHmac, randomInt, timingSafeEqual } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { now } from './db.server.ts'
import { env } from './env.server.ts'
import { emailStatus } from './email.server.ts'
import { hashToken } from './password.server.ts'

// Who the visitor is, for connector lookups. A visitor proves an email
// address one of two ways:
// - a 6-digit code sent to it (needs EMAIL_PROVIDER), or
// - an identity token your own site signs for a signed-in user and passes to
//   the widget (/widget?identity=...), signed with DESK_IDENTITY_SECRET.
// The verified address is kept on the conversation for VERIFIED_HOURS
// (default 24), or until 2 hours pass without a message from the visitor,
// whichever comes first, and is cleared when the conversation ends. After
// that the visitor verifies again: a chat left open on a shared computer
// doesn't keep showing someone's orders.
// Lookups never run for an address that hasn't been proved, so typing someone
// else's email gets nothing.

// Messages here are safe to show visitors.
export class IdentityError extends Error {}

const HOUR_MS = 60 * 60_000
export const VERIFIED_IDLE_MS = 2 * HOUR_MS
const CODE_TTL_MS = 10 * 60_000
const MAX_ATTEMPTS = 5
const LOCK_MS = 15 * 60_000
const TOKEN_MAX_LIFETIME_S = 60 * 60
// Clocks drift; a token a minute "too long" is still fine.
const CLOCK_SKEW_S = 60

const EMAIL = /^[a-z0-9.!#$%&*+/=?^_`{|}~-]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/

// Lowercased address, or null when it isn't one. Deliberately strict: no
// quotes, spaces or brackets, since it's used in search queries upstream.
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const email = raw.trim().toLowerCase()
  return email.length <= 254 && EMAIL.test(email) ? email : null
}

export function identityMethods() {
  return { emailCode: emailStatus().ready, token: Boolean(env.identitySecret) }
}

function codeHash(conversationId: string, code: string): string {
  // Bound to the conversation: a code only works where it was asked for.
  return hashToken(`visitor-code:${conversationId}:${code}`)
}

function minutes(ms: number): string {
  const m = Math.max(1, Math.ceil(ms / 60_000))
  return `${m} minute${m === 1 ? '' : 's'}`
}

type CodeRow = { email: string; code_hash: string; expires_at: string; attempts: number; locked_until: string | null }

function codeRow(db: DatabaseSync, conversationId: string): CodeRow | undefined {
  return db.prepare('SELECT email, code_hash, expires_at, attempts, locked_until FROM visitor_codes WHERE conversation_id = ?').get(conversationId) as
    | CodeRow
    | undefined
}

// Creates a new code for this conversation (replacing any earlier one) and
// returns it, for the caller to email.
export function issueEmailCode(db: DatabaseSync, conversationId: string, email: string, nowMs = Date.now()): string {
  const existing = codeRow(db, conversationId)
  if (existing?.locked_until && Date.parse(existing.locked_until) > nowMs) {
    throw new IdentityError(`Too many wrong codes. Try again in ${minutes(Date.parse(existing.locked_until) - nowMs)}.`)
  }
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
  db.prepare(
    `INSERT INTO visitor_codes (conversation_id, email, code_hash, expires_at, attempts, locked_until) VALUES (?, ?, ?, ?, 0, NULL)
     ON CONFLICT (conversation_id) DO UPDATE SET email = excluded.email, code_hash = excluded.code_hash,
       expires_at = excluded.expires_at, attempts = 0, locked_until = NULL`,
  ).run(conversationId, email, codeHash(conversationId, code), new Date(nowMs + CODE_TTL_MS).toISOString())
  return code
}

// Checks a code; on success the conversation is verified and the email returned.
export function confirmEmailCode(db: DatabaseSync, conversationId: string, rawCode: string, nowMs = Date.now()): string {
  const code = rawCode.replace(/\s/g, '')
  if (!/^\d{6}$/.test(code)) throw new IdentityError('Enter the 6-digit code from the email.')
  const row = codeRow(db, conversationId)
  if (!row) throw new IdentityError('Ask for a code first.')
  if (row.locked_until && Date.parse(row.locked_until) > nowMs) {
    throw new IdentityError(`Too many wrong codes. Try again in ${minutes(Date.parse(row.locked_until) - nowMs)}.`)
  }
  if (Date.parse(row.expires_at) <= nowMs) {
    db.prepare('DELETE FROM visitor_codes WHERE conversation_id = ?').run(conversationId)
    throw new IdentityError('That code has expired. Ask for a new one.')
  }
  const expected = Buffer.from(row.code_hash, 'hex')
  const actual = Buffer.from(codeHash(conversationId, code), 'hex')
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    const attempts = row.attempts + 1
    if (attempts >= MAX_ATTEMPTS) {
      db.prepare('UPDATE visitor_codes SET attempts = ?, locked_until = ? WHERE conversation_id = ?').run(
        attempts,
        new Date(nowMs + LOCK_MS).toISOString(),
        conversationId,
      )
      throw new IdentityError(`Too many wrong codes. Try again in ${minutes(LOCK_MS)}.`)
    }
    db.prepare('UPDATE visitor_codes SET attempts = ? WHERE conversation_id = ?').run(attempts, conversationId)
    const left = MAX_ATTEMPTS - attempts
    throw new IdentityError(`That code isn’t right. ${left} ${left === 1 ? 'try' : 'tries'} left.`)
  }
  db.prepare('DELETE FROM visitor_codes WHERE conversation_id = ?').run(conversationId)
  markVerified(db, conversationId, row.email, 'email_code')
  return row.email
}

export function markVerified(db: DatabaseSync, conversationId: string, email: string, via: 'email_code' | 'identity_token') {
  const ts = now()
  db.prepare('UPDATE conversations SET verified_email = ?, verified_at = ?, verified_via = ?, verified_active_at = ? WHERE id = ?').run(
    email,
    ts,
    via,
    ts,
    conversationId,
  )
}

export function clearVerification(db: DatabaseSync, conversationId: string) {
  db.prepare(
    'UPDATE conversations SET verified_email = NULL, verified_at = NULL, verified_via = NULL, verified_active_at = NULL WHERE id = ?',
  ).run(conversationId)
  db.prepare('DELETE FROM visitor_codes WHERE conversation_id = ?').run(conversationId)
}

// --- How long a verification lasts ---

export interface VerificationRow {
  verified_email: string | null
  verified_at: string | null
  verified_active_at: string | null
}

export interface VerificationLimits {
  // From verification; 0 = no limit.
  maxMs: number
  // Since the visitor's last message.
  idleMs: number
}

export function verificationLimits(): VerificationLimits {
  return { maxMs: env.verifiedHours * HOUR_MS, idleMs: VERIFIED_IDLE_MS }
}

export type VerificationStatus = { state: 'none' } | { state: 'active'; email: string } | { state: 'expired' }

export function verificationStatus(row: VerificationRow, nowMs = Date.now(), limits = verificationLimits()): VerificationStatus {
  if (!row.verified_email || !row.verified_at) return { state: 'none' }
  const verifiedAt = Date.parse(row.verified_at)
  // Verified before activity was tracked: count from the verification.
  const activeAt = Date.parse(row.verified_active_at ?? row.verified_at)
  if (Number.isNaN(verifiedAt) || Number.isNaN(activeAt)) return { state: 'expired' }
  if (limits.maxMs > 0 && nowMs - verifiedAt >= limits.maxMs) return { state: 'expired' }
  if (nowMs - activeAt >= limits.idleMs) return { state: 'expired' }
  return { state: 'active', email: row.verified_email }
}

// The conversation's verified email if it still counts. `touch` is a message
// from the visitor: it counts as activity, and clears a verification that has
// lapsed (so the assistant can say it expired). Reloading the chat neither
// keeps it alive nor clears it, so an open but idle tab still lapses.
export function currentVerification(
  db: DatabaseSync,
  conversationId: string,
  opts: { touch: boolean; nowMs?: number; limits?: VerificationLimits },
): { email: string | null; expired: boolean } {
  const row = db.prepare('SELECT verified_email, verified_at, verified_active_at FROM conversations WHERE id = ?').get(conversationId) as
    | VerificationRow
    | undefined
  if (!row) return { email: null, expired: false }
  const nowMs = opts.nowMs ?? Date.now()
  const status = verificationStatus(row, nowMs, opts.limits)
  if (status.state === 'none') return { email: null, expired: false }
  if (status.state === 'expired') {
    if (opts.touch) clearVerification(db, conversationId)
    return { email: null, expired: true }
  }
  if (opts.touch) {
    db.prepare('UPDATE conversations SET verified_active_at = ? WHERE id = ?').run(new Date(nowMs).toISOString(), conversationId)
  }
  return { email: status.email, expired: false }
}

// --- Identity tokens from your own site ---

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

function tokenSignature(secret: string, payload: string): Buffer {
  return createHmac('sha256', secret).update(payload).digest()
}

// What your server does (in any language): base64url(JSON {email, exp}) + "." + base64url(HMAC-SHA256(secret, that first part)).
export function signIdentityToken(secret: string, email: string, expSeconds: number): string {
  const payload = b64url(JSON.stringify({ email, exp: expSeconds }))
  return `${payload}.${b64url(tokenSignature(secret, payload))}`
}

export function verifyIdentityToken(secret: string, token: string, nowMs = Date.now()): string {
  const invalid = () => new IdentityError('We couldn’t confirm who you are. Reload the page and try again.')
  if (!secret || typeof token !== 'string' || token.length > 1000) throw invalid()
  const parts = token.split('.')
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw invalid()
  const [payloadPart, sigPart] = parts as [string, string]
  const expected = tokenSignature(secret, payloadPart)
  const actual = Buffer.from(sigPart, 'base64url')
  // Signature first: nothing in an unsigned payload is trusted, or even parsed.
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw invalid()
  let payload: unknown
  try {
    payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'))
  } catch {
    throw invalid()
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw invalid()
  const keys = Object.keys(payload).sort()
  if (keys.join(',') !== 'email,exp') throw invalid()
  const { email: rawEmail, exp } = payload as { email: unknown; exp: unknown }
  const email = normalizeEmail(rawEmail)
  if (!email || typeof exp !== 'number' || !Number.isInteger(exp)) throw invalid()
  const nowS = Math.floor(nowMs / 1000)
  if (exp <= nowS) throw new IdentityError('Your sign-in has expired. Reload the page to continue.')
  // Short-lived only: a leaked token stops working within the hour.
  if (exp - nowS > TOKEN_MAX_LIFETIME_S + CLOCK_SKEW_S) throw invalid()
  return email
}
