import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { getDb, now } from './db.server.ts'
import { detectImageType, IMAGE_TYPES } from '../lib/media-core.ts'

// Team members' profile pictures, shown beside their replies in the chat.
// The browser crops and shrinks a photo to a small square first (see
// prepareAvatar); the server only trusts the bytes: a PNG, JPEG or WebP,
// small. Served at /avatars/<hash>, which changes with the picture, so it can
// be cached for good and never names the person.

export const MAX_AVATAR_BYTES = 256 * 1024
const AVATAR_TYPES = ['png', 'jpg', 'webp'] as const

export class AvatarError extends Error {}

export function avatarUrl(hash: string): string {
  return `/avatars/${hash}`
}

export function saveAvatar(userId: string, bytes: Uint8Array, db: DatabaseSync = getDb()): string {
  if (bytes.length > MAX_AVATAR_BYTES) throw new AvatarError('That picture is too large. Choose a smaller one.')
  const ext = detectImageType(bytes)
  if (!ext || !(AVATAR_TYPES as readonly string[]).includes(ext)) throw new AvatarError('Upload a PNG, JPEG or WebP picture.')
  const hash = createHash('sha256').update(bytes).update(userId).digest('hex').slice(0, 24)
  db.prepare(
    `INSERT INTO user_avatars (user_id, type, data, hash, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET type = excluded.type, data = excluded.data, hash = excluded.hash, updated_at = excluded.updated_at`,
  ).run(userId, IMAGE_TYPES[ext], bytes, hash, now())
  return avatarUrl(hash)
}

export function removeAvatar(userId: string, db: DatabaseSync = getDb()) {
  db.prepare('DELETE FROM user_avatars WHERE user_id = ?').run(userId)
}

export function avatarOf(userId: string, db: DatabaseSync = getDb()): string | null {
  const row = db.prepare('SELECT hash FROM user_avatars WHERE user_id = ?').get(userId) as { hash: string } | undefined
  return row ? avatarUrl(row.hash) : null
}

// Pictures for the team members with these ids (who sent a ticket's replies).
export function avatarsByUser(ids: Iterable<string>, db: DatabaseSync = getDb()): Map<string, string> {
  const wanted = [...new Set(ids)].filter(Boolean)
  const out = new Map<string, string>()
  if (!wanted.length) return out
  const rows = db
    .prepare(`SELECT user_id, hash FROM user_avatars WHERE user_id IN (${wanted.map(() => '?').join(', ')})`)
    .all(...wanted) as Array<{ user_id: string; hash: string }>
  for (const r of rows) out.set(r.user_id, avatarUrl(r.hash))
  return out
}

// Pictures for the names on a conversation's team replies (ModelRiver keeps
// the name with each message, not who sent it). A name two people share gets
// no picture rather than the wrong one.
export function avatarsByName(names: Iterable<string>, db: DatabaseSync = getDb()): Map<string, string> {
  const wanted = [...new Set(names)].filter(Boolean)
  const out = new Map<string, string>()
  if (!wanted.length) return out
  const rows = db
    .prepare(
      `SELECT u.name, a.hash, (SELECT COUNT(*) FROM users v WHERE v.name = u.name) AS same
       FROM users u JOIN user_avatars a ON a.user_id = u.id
       WHERE u.name IN (${wanted.map(() => '?').join(', ')})`,
    )
    .all(...wanted) as Array<{ name: string; hash: string; same: number }>
  for (const r of rows) if (r.same === 1) out.set(r.name, avatarUrl(r.hash))
  return out
}

// GET /avatars/<hash>.
export function avatarResponse(hash: string, { head = false } = {}, db: DatabaseSync = getDb()): Response {
  const row = /^[a-f0-9]{24}$/.test(hash)
    ? (db.prepare('SELECT type, data FROM user_avatars WHERE hash = ?').get(hash) as { type: string; data: Uint8Array } | undefined)
    : undefined
  if (!row) return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
  return new Response(head ? null : new Uint8Array(row.data), {
    headers: {
      'Content-Type': row.type,
      'Content-Length': String(row.data.length),
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
