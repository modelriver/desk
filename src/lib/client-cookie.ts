// Cookies set by the widget itself for small UI state (whether the chat was
// open, an answer that was still streaming). The visitor's identity is a
// separate HttpOnly cookie set by the server; these never hold anything secret.

function attributes(maxAgeSeconds: number): string {
  // Over https, allow the cookie inside an iframe embed on another site
  // (partitioned per embedding site). Plain http (local dev) can't use Secure.
  const site = location.protocol === 'https:' ? 'SameSite=None; Secure; Partitioned' : 'SameSite=Lax'
  return `path=/; max-age=${maxAgeSeconds}; ${site}`
}

export function readCookie<T>(name: string): T | null {
  try {
    const prefix = `${name}=`
    const raw = document.cookie
      .split('; ')
      .find((c) => c.startsWith(prefix))
      ?.slice(prefix.length)
    return raw ? (JSON.parse(decodeURIComponent(raw)) as T) : null
  } catch {
    return null
  }
}

export function writeCookie(name: string, value: unknown, maxAgeSeconds: number) {
  try {
    document.cookie = `${name}=${encodeURIComponent(JSON.stringify(value))}; ${attributes(maxAgeSeconds)}`
  } catch {
    // Cookies blocked: the chat just won't reopen or resume after a refresh.
  }
}

export function deleteCookie(name: string) {
  try {
    document.cookie = `${name}=; ${attributes(0)}`
  } catch {
    // ignore
  }
}
