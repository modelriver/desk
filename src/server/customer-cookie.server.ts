import { deleteCookie, getCookie, setCookie } from '@tanstack/react-start/server'
import { env } from './env.server.ts'
import { CUSTOMER_COOKIE, CUSTOMER_SESSION_SECONDS } from './ticket-access.server.ts'

// The signed-in customer's session token (see ticket-access.server.ts).
// HttpOnly, so page scripts can't read it; SameSite=Lax, so it comes along
// when they open a ticket link from their email, but not on other sites' requests.
function options() {
  return { httpOnly: true, secure: env.production, sameSite: 'lax' as const, path: '/' }
}

export function readCustomerCookie(): string | undefined {
  return getCookie(CUSTOMER_COOKIE)
}

export function writeCustomerCookie(token: string) {
  setCookie(CUSTOMER_COOKIE, token, { ...options(), maxAge: CUSTOMER_SESSION_SECONDS })
}

export function clearCustomerCookie() {
  deleteCookie(CUSTOMER_COOKIE, options())
}
