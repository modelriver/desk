import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/server/db.server.ts'
import { backToAi, markHandoff, setTeamMode } from '../src/server/conversation-state.server.ts'

function setup() {
  const db = openDb(':memory:')
  const addUser = (id: string, name: string) =>
    db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, 'x', 'agent', 'now')").run(id, `${id}@example.test`, name)
  addUser('alice', 'Alice')
  addUser('sam', 'Sam')
  db.prepare(
    "INSERT INTO conversations (id, visitor_token_hash, visitor_name, mode, created_at, last_activity_at) VALUES ('c1', 'h', 'Jack', 'ai', 'now', 'now')",
  ).run()
  const row = () =>
    db.prepare('SELECT mode, handoff_requested_at, handoff_reason, assigned_user_id FROM conversations WHERE id = ?').get('c1') as {
      mode: string
      handoff_requested_at: string | null
      handoff_reason: string | null
      assigned_user_id: string | null
    }
  return { db, row }
}

test('a failed AI answer hands the chat to the team with its reason', () => {
  const { db, row } = setup()
  markHandoff(db, 'c1', 'ai_error')
  assert.equal(row().mode, 'human')
  assert.ok(row().handoff_requested_at)
  assert.equal(row().handoff_reason, 'ai_error')
})

test('a visitor already waiting keeps their place and the original reason', () => {
  const { db, row } = setup()
  markHandoff(db, 'c1', 'asked')
  const since = row().handoff_requested_at
  markHandoff(db, 'c1', 'ai_error')
  assert.equal(row().handoff_requested_at, since)
  assert.equal(row().handoff_reason, 'asked')
})

test('taking over records who has the chat; it stays waiting until someone replies', () => {
  const { db, row } = setup()
  markHandoff(db, 'c1', 'asked')
  setTeamMode(db, 'c1', 'human', { handlerId: 'alice' })
  assert.equal(row().assigned_user_id, 'alice')
  assert.ok(row().handoff_requested_at, 'still waiting for a reply')
  setTeamMode(db, 'c1', 'human', { answered: true })
  assert.equal(row().handoff_requested_at, null)
  assert.equal(row().assigned_user_id, 'alice', 'a reply without a handler keeps the current one')
})

test('taking over from a colleague moves the chat to you; handing back clears it', () => {
  const { db, row } = setup()
  setTeamMode(db, 'c1', 'human', { handlerId: 'alice' })
  setTeamMode(db, 'c1', 'human', { handlerId: 'sam' })
  assert.equal(row().assigned_user_id, 'sam')
  setTeamMode(db, 'c1', 'ai')
  assert.equal(row().mode, 'ai')
  assert.equal(row().assigned_user_id, null)
})

test('the visitor going back to the AI clears the wait and the handler', () => {
  const { db, row } = setup()
  markHandoff(db, 'c1', 'asked')
  setTeamMode(db, 'c1', 'human', { handlerId: 'alice' })
  backToAi(db, 'c1')
  assert.deepEqual({ ...row() }, { mode: 'ai', handoff_requested_at: null, handoff_reason: 'asked', assigned_user_id: null })
})

test('removing a team member frees their conversations', () => {
  const { db, row } = setup()
  setTeamMode(db, 'c1', 'human', { handlerId: 'alice' })
  db.prepare("DELETE FROM users WHERE id = 'alice'").run()
  assert.equal(row().assigned_user_id, null)
})
