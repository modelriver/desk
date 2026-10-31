import type { DatabaseSync } from 'node:sqlite'
import { getDb, now } from './db.server.ts'
import { audit } from './integrations.server.ts'

// Whether visitors are offered the chat. Admins can pause it from Settings
// (during an incident, say, or while articles are being rewritten): the chat
// button, the home page's question box and the embeddable widget go away, and
// new chats and messages are refused. Articles and search keep working.

const KEY = 'chat_enabled'
// Whether visitors can ask for a person. Off, the assistant says no one is
// free to chat and offers to raise a ticket (see tickets.server.ts);
// team members can still take over any chat from the dashboard.
const HANDOFF_KEY = 'handoff_enabled'
// Whether visitors and customers can raise new tickets (from the chat while
// "Talk with a person" is off, and in the customer portal). Off, they can still
// read and reply to tickets they have, and the team can still open them.
const TICKETS_KEY = 'tickets_enabled'

export const CHAT_PAUSED_MESSAGE = 'Chat is paused right now. Please browse our articles, or try again later.'
export const HANDOFF_OFF_MESSAGE = 'No one from the team is available to chat right now. You can raise a ticket instead.'
export const TICKETS_OFF_MESSAGE = 'We’re not taking new tickets right now. Please browse our articles, or try again later.'

export interface ChatStatus {
  enabled: boolean
  // When and by whom it was last turned on or off (null if never).
  changedAt: string | null
  changedBy: string | null
}

function readToggle(db: DatabaseSync, key: string): ChatStatus {
  const row = db.prepare('SELECT value, updated_at, updated_by FROM app_settings WHERE key = ?').get(key) as
    | { value: string; updated_at: string; updated_by: string | null }
    | undefined
  return { enabled: row?.value !== 'off', changedAt: row?.updated_at ?? null, changedBy: row?.updated_by ?? null }
}

function writeToggle(db: DatabaseSync, key: string, enabled: boolean, user: { id: string; name: string }, action: string) {
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  ).run(key, enabled ? 'on' : 'off', now(), user.name)
  audit(db, user, action, 'chat')
}

export function chatStatus(db: DatabaseSync = getDb()): ChatStatus {
  return readToggle(db, KEY)
}

export function chatEnabled(db: DatabaseSync = getDb()): boolean {
  return chatStatus(db).enabled
}

export function setChatEnabled(enabled: boolean, user: { id: string; name: string }, db: DatabaseSync = getDb()): ChatStatus {
  if (chatEnabled(db) === enabled) return chatStatus(db)
  writeToggle(db, KEY, enabled, user, enabled ? 'chat.resumed' : 'chat.paused')
  return chatStatus(db)
}

export function handoffStatus(db: DatabaseSync = getDb()): ChatStatus {
  return readToggle(db, HANDOFF_KEY)
}

export function handoffEnabled(db: DatabaseSync = getDb()): boolean {
  return handoffStatus(db).enabled
}

export function ticketsStatus(db: DatabaseSync = getDb()): ChatStatus {
  return readToggle(db, TICKETS_KEY)
}

export function ticketsEnabled(db: DatabaseSync = getDb()): boolean {
  return ticketsStatus(db).enabled
}

export function setTicketsEnabled(enabled: boolean, user: { id: string; name: string }, db: DatabaseSync = getDb()): ChatStatus {
  if (ticketsEnabled(db) === enabled) return ticketsStatus(db)
  writeToggle(db, TICKETS_KEY, enabled, user, enabled ? 'tickets.enabled' : 'tickets.disabled')
  return ticketsStatus(db)
}

export function setHandoffEnabled(enabled: boolean, user: { id: string; name: string }, db: DatabaseSync = getDb()): ChatStatus {
  if (handoffEnabled(db) === enabled) return handoffStatus(db)
  writeToggle(db, HANDOFF_KEY, enabled, user, enabled ? 'handoff.enabled' : 'handoff.disabled')
  return handoffStatus(db)
}
