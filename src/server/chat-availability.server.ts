import type { DatabaseSync } from 'node:sqlite'
import { getDb, now } from './db.server.ts'
import { audit } from './integrations.server.ts'

// Whether visitors are offered the chat. Admins can pause it from Settings
// (during an incident, say, or while articles are being rewritten): the chat
// button, the home page's question box and the embeddable widget go away, and
// new chats and messages are refused. Articles and search keep working.

const KEY = 'chat_enabled'

export const CHAT_PAUSED_MESSAGE = 'Chat is paused right now. Please browse our articles, or try again later.'

export interface ChatStatus {
  enabled: boolean
  // When and by whom it was last turned on or off (null if never).
  changedAt: string | null
  changedBy: string | null
}

export function chatStatus(db: DatabaseSync = getDb()): ChatStatus {
  const row = db.prepare('SELECT value, updated_at, updated_by FROM app_settings WHERE key = ?').get(KEY) as
    | { value: string; updated_at: string; updated_by: string | null }
    | undefined
  return { enabled: row?.value !== 'off', changedAt: row?.updated_at ?? null, changedBy: row?.updated_by ?? null }
}

export function chatEnabled(db: DatabaseSync = getDb()): boolean {
  return chatStatus(db).enabled
}

export function setChatEnabled(enabled: boolean, user: { id: string; name: string }, db: DatabaseSync = getDb()): ChatStatus {
  if (chatEnabled(db) === enabled) return chatStatus(db)
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  ).run(KEY, enabled ? 'on' : 'off', now(), user.name)
  audit(db, user, enabled ? 'chat.resumed' : 'chat.paused', 'chat')
  return chatStatus(db)
}
