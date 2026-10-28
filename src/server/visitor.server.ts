import { randomBytes } from 'node:crypto'
import { deleteCookie, getCookie, setCookie } from '@tanstack/react-start/server'
import { env } from './env.server.ts'
import { encodeVisitorCookie, parseVisitorCookie, VISITOR_COOKIE } from './visitor-cookie.ts'

// HttpOnly, so page scripts (and any injected script) can't read the token.
// In production it is SameSite=None + Partitioned so the chat keeps working
// when /widget is embedded in an iframe on another site; cross-site POSTs are
// still rejected by the CSRF middleware in src/start.ts.
function cookieOptions() {
  const maxAge = env.visitorCookieDays > 0 ? env.visitorCookieDays * 86_400 : undefined
  return env.production
    ? { httpOnly: true, secure: true, sameSite: 'none' as const, partitioned: true, path: '/', maxAge }
    : { httpOnly: true, sameSite: 'lax' as const, path: '/', maxAge }
}

export function readVisitorCookie() {
  return parseVisitorCookie(getCookie(VISITOR_COOKIE))
}

// Also called on activity, so the expiry slides forward while someone uses the chat.
export function writeVisitorCookie(conversationId: string, token: string) {
  setCookie(VISITOR_COOKIE, encodeVisitorCookie(conversationId, token), cookieOptions())
}

// A random per-browser ID, used only to pace how often a browser can start a
// new chat after ending one. Lasts a year; holds nothing about the visitor.
const DEVICE_COOKIE = 'desk_device'

export function deviceId(create: boolean): string | null {
  const existing = getCookie(DEVICE_COOKIE)
  if (existing && /^[A-Za-z0-9_-]{22}$/.test(existing)) return existing
  if (!create) return null
  const id = randomBytes(16).toString('base64url')
  const { maxAge: _maxAge, ...options } = cookieOptions()
  setCookie(DEVICE_COOKIE, id, { ...options, maxAge: 365 * 86_400 })
  return id
}

export function clearVisitorCookie() {
  const { maxAge: _maxAge, ...options } = cookieOptions()
  deleteCookie(VISITOR_COOKIE, options)
}
