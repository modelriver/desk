import { getDb } from './db.server.ts'
import { emailStatus } from './email.server.ts'

// A team member's own account: their notification choices.

export interface NotificationPrefs {
  handoff: boolean
  newConversations: boolean
}

export function getAccount(userId: string) {
  const row = getDb()
    .prepare('SELECT name, email, role, totp_enabled_at, notify_handoff, notify_new_conversations FROM users WHERE id = ?')
    .get(userId) as {
    name: string
    email: string
    role: 'admin' | 'agent'
    totp_enabled_at: string | null
    notify_handoff: number
    notify_new_conversations: number
  }
  const email = emailStatus()
  return {
    name: row.name,
    email: row.email,
    role: row.role,
    twoFactorSince: row.totp_enabled_at,
    notifications: { handoff: row.notify_handoff === 1, newConversations: row.notify_new_conversations === 1 },
    // Whether this server can send email at all; the page explains if not.
    emailReady: email.ready,
  }
}

export function setNotificationPrefs(userId: string, prefs: NotificationPrefs) {
  getDb()
    .prepare('UPDATE users SET notify_handoff = ?, notify_new_conversations = ? WHERE id = ?')
    .run(prefs.handoff ? 1 : 0, prefs.newConversations ? 1 : 0, userId)
}
