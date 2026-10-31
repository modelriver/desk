import { randomInt, timingSafeEqual } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { getDb, now } from './db.server.ts'
import { hashToken, newToken } from './password.server.ts'

// How a customer opens their ticket at /tickets/<ref>, to read the replies
// and answer:
// - the link in a reply email carries a private key for that ticket (30 days),
//   which signs them in for the ticket's email address;
// - without it, a 6-digit code sent to that address does the same.
// Signing in is a session for the email address (an HttpOnly cookie, 14 days):
// it opens the customer portal (/customer-portal) with every ticket raised with
// that address, and nothing else. Keys, codes and session tokens are stored
// hashed. The team can block an address (see Blocked customers below).

const DAY = 24 * 60 * 60_000
const LINK_TTL_MS = 30 * DAY
const SESSION_TTL_MS = 14 * DAY
const CODE_TTL_MS = 10 * 60_000
const MAX_ATTEMPTS = 5
const LOCK_MS = 15 * 60_000

export const CUSTOMER_COOKIE = 'desk_customer'
export const CUSTOMER_SESSION_SECONDS = SESSION_TTL_MS / 1000

export class AccessError extends Error {}

// A new private key for a ticket's reply email.
export function createTicketLink(db: DatabaseSync, ticketId: number, email: string, nowMs = Date.now()): string {
  const key = newToken()
  db.prepare('INSERT INTO ticket_links (token_hash, ticket_id, email, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(
    hashToken(`ticket-link:${key}`),
    ticketId,
    email,
    new Date(nowMs).toISOString(),
    new Date(nowMs + LINK_TTL_MS).toISOString(),
  )
  return key
}

// The email a key signs in as, if it's a live key for this ticket and the
// ticket still has that address (a key for an old address stops working).
export function redeemTicketLink(db: DatabaseSync, ref: string, key: string, nowMs = Date.now()): string | null {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(key)) return null
  const row = db
    .prepare(
      `SELECT l.email FROM ticket_links l JOIN tickets t ON t.id = l.ticket_id
       WHERE l.token_hash = ? AND t.ref = ? AND l.expires_at > ? AND t.email = l.email
         AND l.email NOT IN (SELECT email FROM blocked_customers)`,
    )
    .get(hashToken(`ticket-link:${key}`), ref, new Date(nowMs).toISOString()) as { email: string } | undefined
  return row?.email ?? null
}

export function startCustomerSession(db: DatabaseSync, email: string, nowMs = Date.now()): string {
  const token = newToken()
  db.prepare('INSERT INTO customer_sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
    hashToken(`customer-session:${token}`),
    email,
    new Date(nowMs).toISOString(),
    new Date(nowMs + SESSION_TTL_MS).toISOString(),
  )
  return token
}

export function customerSessionEmail(db: DatabaseSync, token: string | undefined, nowMs = Date.now()): string | null {
  if (!token || !/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null
  const row = db
    .prepare('SELECT email FROM customer_sessions WHERE token_hash = ? AND expires_at > ? AND email NOT IN (SELECT email FROM blocked_customers)')
    .get(hashToken(`customer-session:${token}`), new Date(nowMs).toISOString()) as { email: string } | undefined
  return row?.email ?? null
}

export function endCustomerSession(db: DatabaseSync, token: string | undefined) {
  if (token) db.prepare('DELETE FROM customer_sessions WHERE token_hash = ?').run(hashToken(`customer-session:${token}`))
}

function codeHash(email: string, code: string): string {
  // Bound to the address: a code only opens tickets for the email it went to.
  return hashToken(`customer-code:${email}:${code}`)
}

function minutes(ms: number): string {
  const m = Math.max(1, Math.ceil(ms / 60_000))
  return `${m} minute${m === 1 ? '' : 's'}`
}

type CodeRow = { code_hash: string; expires_at: string; attempts: number; locked_until: string | null }

export function issueCustomerCode(db: DatabaseSync, email: string, nowMs = Date.now()): string {
  const existing = db.prepare('SELECT locked_until FROM customer_codes WHERE email = ?').get(email) as { locked_until: string | null } | undefined
  if (existing?.locked_until && Date.parse(existing.locked_until) > nowMs) {
    throw new AccessError(`Too many wrong codes. Try again in ${minutes(Date.parse(existing.locked_until) - nowMs)}.`)
  }
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
  db.prepare(
    `INSERT INTO customer_codes (email, code_hash, expires_at, attempts, locked_until) VALUES (?, ?, ?, 0, NULL)
     ON CONFLICT (email) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, locked_until = NULL`,
  ).run(email, codeHash(email, code), new Date(nowMs + CODE_TTL_MS).toISOString())
  return code
}

// Five wrong codes lock the address for 15 minutes.
export function confirmCustomerCode(db: DatabaseSync, email: string, rawCode: string, nowMs = Date.now()): void {
  const code = rawCode.replace(/\s/g, '')
  if (!/^\d{6}$/.test(code)) throw new AccessError('Enter the 6-digit code from the email.')
  const row = db.prepare('SELECT code_hash, expires_at, attempts, locked_until FROM customer_codes WHERE email = ?').get(email) as CodeRow | undefined
  if (!row) throw new AccessError('Ask for a code first.')
  if (row.locked_until && Date.parse(row.locked_until) > nowMs) {
    throw new AccessError(`Too many wrong codes. Try again in ${minutes(Date.parse(row.locked_until) - nowMs)}.`)
  }
  if (Date.parse(row.expires_at) <= nowMs) {
    db.prepare('DELETE FROM customer_codes WHERE email = ?').run(email)
    throw new AccessError('That code has expired. Ask for a new one.')
  }
  const expected = Buffer.from(row.code_hash, 'hex')
  const actual = Buffer.from(codeHash(email, code), 'hex')
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    const attempts = row.attempts + 1
    if (attempts >= MAX_ATTEMPTS) {
      db.prepare('UPDATE customer_codes SET attempts = ?, locked_until = ? WHERE email = ?').run(attempts, new Date(nowMs + LOCK_MS).toISOString(), email)
      throw new AccessError(`Too many wrong codes. Try again in ${minutes(LOCK_MS)}.`)
    }
    db.prepare('UPDATE customer_codes SET attempts = ? WHERE email = ?').run(attempts, email)
    const left = MAX_ATTEMPTS - attempts
    throw new AccessError(`That code isn’t right. ${left} ${left === 1 ? 'try' : 'tries'} left.`)
  }
  db.prepare('DELETE FROM customer_codes WHERE email = ?').run(email)
}

// --- Blocked customers ---
// An address the team blocked gets no codes, can't sign in or use a link from
// an older email, and can't raise tickets or reply. Nothing tells them: they
// see the same answers as anyone whose code didn't arrive. The team can still
// write to them.

export function isBlocked(db: DatabaseSync, email: string | null): boolean {
  if (!email) return false
  return db.prepare('SELECT 1 FROM blocked_customers WHERE email = ?').get(email) !== undefined
}

// Blocks an address and ends its open sessions and pending codes at once.
export function blockCustomer(db: DatabaseSync, email: string, by: { name: string }, reason: string | null = null): void {
  db.prepare(
    `INSERT INTO blocked_customers (email, blocked_at, blocked_by, reason) VALUES (?, ?, ?, ?)
     ON CONFLICT (email) DO UPDATE SET reason = coalesce(excluded.reason, reason)`,
  ).run(email, now(), by.name, reason)
  db.prepare('DELETE FROM customer_sessions WHERE email = ?').run(email)
  db.prepare('DELETE FROM customer_codes WHERE email = ?').run(email)
}

export function unblockCustomer(db: DatabaseSync, email: string): boolean {
  return Number(db.prepare('DELETE FROM blocked_customers WHERE email = ?').run(email).changes) > 0
}

export function blockedCustomers(db: DatabaseSync = getDb()) {
  return (
    db.prepare('SELECT email, blocked_at, blocked_by, reason FROM blocked_customers ORDER BY blocked_at DESC LIMIT 500').all() as Array<{
      email: string
      blocked_at: string
      blocked_by: string | null
      reason: string | null
    }>
  ).map((r) => ({ email: r.email, blockedAt: r.blocked_at, blockedBy: r.blocked_by, reason: r.reason }))
}

// Hourly cleanup: expired keys, sessions and codes.
export function pruneTicketAccess(db: DatabaseSync = getDb()): number {
  const ts = now()
  return (
    Number(db.prepare('DELETE FROM ticket_links WHERE expires_at <= ?').run(ts).changes) +
    Number(db.prepare('DELETE FROM customer_sessions WHERE expires_at <= ?').run(ts).changes) +
    Number(db.prepare('DELETE FROM customer_codes WHERE expires_at <= ? AND (locked_until IS NULL OR locked_until <= ?)').run(ts, ts).changes)
  )
}
