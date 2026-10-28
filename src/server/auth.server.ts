import { deleteCookie, getCookie, getRequest, getRequestIP, setCookie } from '@tanstack/react-start/server'
import { getDb } from './db.server.ts'
import { env } from './env.server.ts'
import { allowAll } from './rate-limit.server.ts'
import { pickClientIp } from './client-ip.server.ts'
import { hashToken, newToken, verifyPassword } from './password.server.ts'
import { sessionUser } from './account-security.server.ts'

export type Role = 'admin' | 'agent'

export interface User {
  id: string
  email: string
  name: string
  role: Role
}

const COOKIE = 'desk_session'
const SESSION_DAYS = 14

export class AuthError extends Error {}

// Step 1 of sign-in. Returns the user when the password is right; no session
// is created here; that happens after the second factor (two-factor.server.ts).
export async function checkPassword(email: string, password: string): Promise<User & { twoFactorEnabled: boolean }> {
  const ip = clientIp()
  const account = email.trim().toLowerCase()
  const window = 15 * 60_000
  // Per IP+account, per account across all IPs (credential stuffing from a
  // botnet), and per IP across all accounts (password spraying).
  const allowed = allowAll([
    { key: `login:${ip}:${account}`, max: 10, windowMs: window },
    { key: `login-account:${account}`, max: 30, windowMs: window },
    { key: `login-ip:${ip}`, max: 50, windowMs: window },
  ])
  if (!allowed) {
    throw new AuthError('Too many login attempts. Try again in a few minutes.')
  }
  const row = getDb()
    // Emails match whatever their case: Sam@Example.com signs in as sam@example.com.
    .prepare('SELECT id, email, name, role, password_hash, totp_enabled_at FROM users WHERE email = ?')
    .get(account) as (User & { password_hash: string; totp_enabled_at: string | null }) | undefined
  // Verify against a dummy hash when the user is missing to keep timing similar.
  const ok = await verifyPassword(password, row?.password_hash ?? DUMMY_HASH)
  if (!row || !ok) throw new AuthError('Invalid email or password.')
  return { id: row.id, email: row.email, name: row.name, role: row.role, twoFactorEnabled: row.totp_enabled_at !== null }
}

// Only called once both factors have been checked (twoFactor: true), or the
// password alone with DISABLE_TWO_FACTOR=true (twoFactor: false).
export function createSession(userId: string, { twoFactor }: { twoFactor: boolean }) {
  const token = newToken()
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000)
  getDb()
    .prepare('INSERT INTO auth_sessions (token_hash, user_id, expires_at, two_factor) VALUES (?, ?, ?, ?)')
    .run(hashToken(token), userId, expires.toISOString(), twoFactor ? 1 : 0)
  setCookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.production,
    path: '/',
    expires,
  })
}

// After a password change: every other sign-in of this account ends; the
// current one (if it's theirs) stays.
export function signOutOtherSessions(userId: string) {
  const token = getCookie(COOKIE)
  getDb()
    .prepare('DELETE FROM auth_sessions WHERE user_id = ? AND token_hash != ?')
    .run(userId, token ? hashToken(token) : '')
}

export function logout() {
  const token = getCookie(COOKIE)
  if (token) getDb().prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(hashToken(token))
  deleteCookie(COOKIE, { path: '/' })
}

// 2FA is required for everyone; see sessionUser for the rule.
export function currentUser(): User | null {
  const token = getCookie(COOKIE)
  if (!token) return null
  return sessionUser(getDb(), hashToken(token), env.twoFactorDisabled)
}

export function clientIp(): string {
  // getRequestIP() without options is the socket address (set by server.mjs).
  return pickClientIp(getRequest().headers, getRequestIP(), {
    trustedHops: env.trustedProxyHops,
    clientIpHeader: env.clientIpHeader,
  })
}

export function requireUser(role?: Role): User {
  const user = currentUser()
  if (!user) throw new AuthError('Not signed in.')
  if (role === 'admin' && user.role !== 'admin') throw new AuthError('Admins only.')
  return user
}

const DUMMY_HASH =
  'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=='
