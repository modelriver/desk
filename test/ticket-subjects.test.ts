import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/server/db.server.ts'
import {
  addTicketSubject,
  knownTicketSubject,
  listTicketSubjects,
  moveTicketSubject,
  removeTicketSubject,
  TICKET_SUBJECT_LIMITS,
  ticketSubjectNames,
} from '../src/server/ticket-subjects.server.ts'

test('subjects keep the order they were added in, and can be moved and removed', () => {
  const db = openDb(':memory:')
  assert.deepEqual(ticketSubjectNames(db), [])
  const billing = addTicketSubject('  Billing   and payments ', db)
  const bug = addTicketSubject('Something’s broken', db)
  addTicketSubject('My order', db)
  assert.equal(billing.name, 'Billing and payments')
  assert.deepEqual(ticketSubjectNames(db), ['Billing and payments', 'Something’s broken', 'My order'])

  moveTicketSubject(bug.id, -1, db)
  assert.deepEqual(ticketSubjectNames(db), ['Something’s broken', 'Billing and payments', 'My order'])
  // Past either end: nothing moves.
  moveTicketSubject(bug.id, -1, db)
  assert.deepEqual(ticketSubjectNames(db)[0], 'Something’s broken')

  assert.equal(removeTicketSubject(billing.id, db), 'Billing and payments')
  assert.equal(removeTicketSubject(billing.id, db), null)
  assert.deepEqual(listTicketSubjects(db).map((s) => s.name), ['Something’s broken', 'My order'])
  // A new one goes last.
  addTicketSubject('Billing and payments', db)
  assert.deepEqual(ticketSubjectNames(db), ['Something’s broken', 'My order', 'Billing and payments'])
})

test('a subject needs a name, can’t repeat (in any case), and the list has a limit', () => {
  const db = openDb(':memory:')
  addTicketSubject('Billing', db)
  assert.throws(() => addTicketSubject('   ', db), /Give the subject a name/)
  assert.throws(() => addTicketSubject('billing', db), /already in the list/)
  assert.throws(() => addTicketSubject('x'.repeat(TICKET_SUBJECT_LIMITS.name + 1), db), /60 characters/)
  for (let i = 1; i < TICKET_SUBJECT_LIMITS.count; i++) addTicketSubject(`Subject ${i}`, db)
  assert.throws(() => addTicketSubject('One too many', db), /up to 20 subjects/)
})

test('the chat only takes a subject from the list, written as the list has it', () => {
  const db = openDb(':memory:')
  addTicketSubject('Billing', db)
  assert.equal(knownTicketSubject('Billing', db), 'Billing')
  assert.equal(knownTicketSubject(' billing ', db), 'Billing')
  assert.equal(knownTicketSubject('Free money', db), null)
  assert.equal(knownTicketSubject(null, db), null)
  assert.equal(knownTicketSubject(42, db), null)
})
