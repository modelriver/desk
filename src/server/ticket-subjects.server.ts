import type { DatabaseSync } from 'node:sqlite'
import { getDb, now } from './db.server.ts'

// The subjects customers pick from when they raise a ticket (in the chat or
// the customer portal), set up by admins under Tickets → Subjects. With none,
// the forms work as before: the portal asks for a subject, and a ticket from
// the chat takes one from the message.

export const TICKET_SUBJECT_LIMITS = { name: 60, count: 20 } as const

export class TicketSubjectError extends Error {}

export interface TicketSubject {
  id: number
  name: string
}

export function listTicketSubjects(db: DatabaseSync = getDb()): TicketSubject[] {
  return db.prepare('SELECT id, name FROM ticket_subjects ORDER BY position, id').all() as unknown as TicketSubject[]
}

export function ticketSubjectNames(db: DatabaseSync = getDb()): string[] {
  return listTicketSubjects(db).map((s) => s.name)
}

export function addTicketSubject(name: string, db: DatabaseSync = getDb()): TicketSubject {
  const clean = name.replace(/\s+/g, ' ').trim()
  if (!clean) throw new TicketSubjectError('Give the subject a name.')
  if (clean.length > TICKET_SUBJECT_LIMITS.name) throw new TicketSubjectError(`Keep it to ${TICKET_SUBJECT_LIMITS.name} characters.`)
  const { count, last } = db.prepare('SELECT count(*) AS count, max(position) AS last FROM ticket_subjects').get() as { count: number; last: number | null }
  if (count >= TICKET_SUBJECT_LIMITS.count) throw new TicketSubjectError(`There can be up to ${TICKET_SUBJECT_LIMITS.count} subjects. Remove one first.`)
  if (db.prepare('SELECT 1 FROM ticket_subjects WHERE name = ?').get(clean)) throw new TicketSubjectError('That subject is already in the list.')
  const r = db.prepare('INSERT INTO ticket_subjects (name, position, created_at) VALUES (?, ?, ?)').run(clean, (last ?? 0) + 1, now())
  return { id: Number(r.lastInsertRowid), name: clean }
}

export function removeTicketSubject(id: number, db: DatabaseSync = getDb()): string | null {
  const row = db.prepare('DELETE FROM ticket_subjects WHERE id = ? RETURNING name').get(id) as { name: string } | undefined
  return row?.name ?? null
}

// Moves a subject one place up (-1) or down (1) the list.
export function moveTicketSubject(id: number, by: -1 | 1, db: DatabaseSync = getDb()): void {
  const list = listTicketSubjects(db)
  const from = list.findIndex((s) => s.id === id)
  const to = from + by
  if (from < 0 || to < 0 || to >= list.length) return
  ;[list[from], list[to]] = [list[to]!, list[from]!]
  const set = db.prepare('UPDATE ticket_subjects SET position = ? WHERE id = ?')
  list.forEach((s, i) => set.run(i + 1, s.id))
}

// The subject a customer picked, as it's written in the list, or null if it
// isn't one of them (the chat only offers the list).
export function knownTicketSubject(chosen: unknown, db: DatabaseSync = getDb()): string | null {
  if (typeof chosen !== 'string' || !chosen.trim()) return null
  const row = db.prepare('SELECT name FROM ticket_subjects WHERE name = ?').get(chosen.trim()) as { name: string } | undefined
  return row?.name ?? null
}
