// The visitor cookie holds "<conversation id>.<visitor token>". Pure helpers,
// kept apart from the request code so they can be unit tested.

export const VISITOR_COOKIE = 'desk_visitor'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TOKEN = /^[A-Za-z0-9_-]{43}$/ // 32 random bytes, base64url

export function encodeVisitorCookie(conversationId: string, token: string): string {
  return `${conversationId}.${token}`
}

export function parseVisitorCookie(value: string | undefined): { conversationId: string; token: string } | null {
  if (!value) return null
  const dot = value.indexOf('.')
  const conversationId = value.slice(0, dot)
  const token = value.slice(dot + 1)
  if (dot < 0 || !UUID.test(conversationId) || !TOKEN.test(token)) return null
  return { conversationId: conversationId.toLowerCase(), token }
}

// Visitor names are shown to the team and passed to the AI: one line of plain
// text, no control characters, at most 60 characters.
export function cleanVisitorName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const name = raw
    // Line breaks and other control characters become spaces; invisible
    // formatting characters (zero-width, bidi overrides) are dropped.
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return name.length >= 1 && name.length <= 60 ? name : null
}
