import { getDb } from './db.server.ts'
import { emailStatus } from './email.server.ts'
import { avatarOf } from './avatars.server.ts'

// A team member's own account: their notification choices.

export interface NotificationPrefs {
  handoff: boolean
  newConversations: boolean
  newTickets: boolean
  myTickets: boolean
}

export function getAccount(userId: string) {
  const row = getDb()
    .prepare('SELECT name, email, role, totp_enabled_at, notify_handoff, notify_new_conversations, notify_new_tickets, notify_my_tickets FROM users WHERE id = ?')
    .get(userId) as {
    name: string
    email: string
    role: 'admin' | 'agent'
    totp_enabled_at: string | null
    notify_handoff: number
    notify_new_conversations: number
    notify_new_tickets: number
    notify_my_tickets: number
  }
  const email = emailStatus()
  return {
    name: row.name,
    email: row.email,
    role: row.role,
    twoFactorSince: row.totp_enabled_at,
    // Shown beside this person's replies in the chat.
    avatar: avatarOf(userId),
    notifications: {
      handoff: row.notify_handoff === 1,
      newConversations: row.notify_new_conversations === 1,
      newTickets: row.notify_new_tickets === 1,
      myTickets: row.notify_my_tickets === 1,
    },
    // Whether this server can send email at all; the page explains if not.
    emailReady: email.ready,
  }
}

export function setNotificationPrefs(userId: string, prefs: NotificationPrefs) {
  getDb()
    .prepare('UPDATE users SET notify_handoff = ?, notify_new_conversations = ?, notify_new_tickets = ?, notify_my_tickets = ? WHERE id = ?')
    .run(prefs.handoff ? 1 : 0, prefs.newConversations ? 1 : 0, prefs.newTickets ? 1 : 0, prefs.myTickets ? 1 : 0, userId)
}
