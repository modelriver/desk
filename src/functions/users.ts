import { createServerFn } from '@tanstack/react-start'
import { asObject, oneOf, str, uuid } from './validate.ts'
import { checkPassword, createSession, currentUser, logout, requireUser, signOutOtherSessions } from '../server/auth.server.ts'
import { allowAll } from '../server/rate-limit.server.ts'
import { isLocked, LOCKED_MESSAGE } from '../server/account-security.server.ts'
import { env } from '../server/env.server.ts'
import { completeSetup, resetTwoFactor, startChallenge, verifySignInCode } from '../server/two-factor.server.ts'
import { otpauthUrl } from '../server/totp.server.ts'
import { renderSVG } from 'uqr'
import { getSiteConfig } from '../server/site-config.server.ts'
import { getDb, now } from '../server/db.server.ts'
import { hashPassword, MIN_PASSWORD_LENGTH, newTemporaryPassword, verifyPassword } from '../server/password.server.ts'

const ROLES = ['admin', 'agent'] as const

function password(o: Record<string, unknown>, key = 'password') {
  return str(o, key, { min: MIN_PASSWORD_LENGTH, max: 200 })
}

export const getMe = createServerFn({ method: 'GET' }).handler(async () => currentUser())

// Step 1: password. The response says what comes next: a code from the
// authenticator app, or (first time, or after a reset) setting one up.
export const signIn = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const o = asObject(input)
    return { email: str(o, 'email', { max: 200 }), password: str(o, 'password', { max: 200 }) }
  })
  .handler(async ({ data }) => {
    const user = await checkPassword(data.email, data.password)
    if (env.twoFactorDisabled) {
      createSession(user.id, { twoFactor: false })
      return { step: 'done' as const }
    }
    // Locked after too many wrong codes: say so now rather than after the code step.
    if (isLocked(getDb(), user.id)) throw new Error(LOCKED_MESSAGE)
    if (user.twoFactorEnabled) {
      startChallenge(user.id, false)
      return { step: 'code' as const }
    }
    const { secret } = startChallenge(user.id, true)
    const issuer = getSiteConfig().config.brand.name
    const url = otpauthUrl(secret!, user.email, issuer)
    // Rendered here so the QR encoder never ships to the browser. Black on
    // white with a quiet border scans reliably, including in dark mode.
    const qr = renderSVG(url, { ecc: 'M', border: 2, whiteColor: '#ffffff', blackColor: '#000000' })
    return {
      step: 'setup' as const,
      secret: secret!,
      otpauthUrl: url,
      qrDataUrl: `data:image/svg+xml;base64,${Buffer.from(qr).toString('base64')}`,
      account: user.email,
    }
  })

// Step 2: a 6-digit authenticator code or a one-time recovery code.
export const verifyTwoFactorCode = createServerFn({ method: 'POST' })
  .validator((input: unknown) => ({ code: str(asObject(input), 'code', { max: 40 }) }))
  .handler(async ({ data }) => verifySignInCode(data.code))

// Step 2 on first sign-in: the code that proves the authenticator app is set up.
export const completeTwoFactorSetup = createServerFn({ method: 'POST' })
  .validator((input: unknown) => ({ code: str(asObject(input), 'code', { max: 20 }) }))
  .handler(async ({ data }) => completeSetup(data.code))

// Admins: for someone who lost their phone and recovery codes. Signs them out;
// they set up 2FA again at their next sign-in.
export const resetUserTwoFactor = createServerFn({ method: 'POST' })
  .validator((input: unknown) => ({ id: uuid(asObject(input), 'id') }))
  .handler(async ({ data }) => {
    const me = requireUser('admin')
    if (me.id === data.id) throw new Error('You can’t reset your own two-factor authentication. Ask another admin.')
    resetTwoFactor(data.id)
    return { ok: true }
  })

export const signOut = createServerFn({ method: 'POST' }).handler(async () => {
  logout()
  return { ok: true }
})

export const listUsers = createServerFn({ method: 'GET' }).handler(async () => {
  requireUser('admin')
  const rows = getDb()
    .prepare('SELECT id, email, name, role, created_at, totp_enabled_at FROM users ORDER BY created_at')
    .all() as Array<{ id: string; email: string; name: string; role: 'admin' | 'agent'; created_at: string; totp_enabled_at: string | null }>
  return rows.map(({ totp_enabled_at, ...u }) => ({ ...u, twoFactorEnabled: totp_enabled_at !== null }))
})

export const createUser = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const o = asObject(input)
    const email = str(o, 'email', { max: 200 })
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email.')
    return { email: email.toLowerCase(), name: str(o, 'name', { max: 100 }), role: oneOf(o, 'role', ROLES) }
  })
  .handler(async ({ data }) => {
    requireUser('admin')
    const exists = getDb().prepare('SELECT 1 FROM users WHERE lower(email) = ?').get(data.email)
    if (exists) throw new Error('Someone with that email is already on the team.')
    const id = crypto.randomUUID()
    // Generated here rather than typed by the admin, so it's always strong.
    // Returned once for the admin to pass on; only its hash is stored.
    const temporaryPassword = newTemporaryPassword()
    getDb()
      .prepare('INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, data.email, data.name, await hashPassword(temporaryPassword), data.role, now())
    return { id, name: data.name, email: data.email, role: data.role, temporaryPassword }
  })

export const deleteUser = createServerFn({ method: 'POST' })
  .validator((input: unknown) => ({ id: uuid(asObject(input), 'id') }))
  .handler(async ({ data }) => {
    const me = requireUser('admin')
    if (me.id === data.id) throw new Error('You cannot delete your own account.')
    getDb().prepare('DELETE FROM users WHERE id = ?').run(data.id)
    return { ok: true }
  })

// Admins can reset anyone's password; everyone can change their own, which
// needs their current password (so a stolen session alone can't lock them out).
export const setPassword = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const o = asObject(input)
    const current = o.currentPassword
    return {
      id: uuid(o, 'id'),
      password: password(o),
      // Trimmed like the new password and the sign-in password, so a password
      // saved with surrounding spaces can still be confirmed.
      currentPassword: typeof current === 'string' && current.trim() ? current.trim().slice(0, 200) : null,
    }
  })
  .handler(async ({ data }) => {
    const me = requireUser()
    const self = me.id === data.id
    if (!self && me.role !== 'admin') throw new Error('Admins only.')
    const db = getDb()
    if (self) {
      if (!data.currentPassword) throw new Error('Enter your current password.')
      if (!allowAll([{ key: `pw-change:${me.id}`, max: 10, windowMs: 15 * 60_000 }])) {
        throw new Error('Too many attempts. Try again in a few minutes.')
      }
      const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(me.id) as { password_hash: string }
      if (!(await verifyPassword(data.currentPassword, row.password_hash))) throw new Error('Your current password is wrong.')
    }
    const updated = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(data.password), data.id)
    if (updated.changes === 0) throw new Error('User not found.')
    // Every other sign-in of the account ends, including any an attacker may hold.
    if (self) signOutOtherSessions(me.id)
    else db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(data.id)
    return { ok: true }
  })
