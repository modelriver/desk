import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// The database path is read when the modules first load, so point it at a
// throwaway file before loading them.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-chat-'))
process.env.DATABASE_PATH = path.join(dir, 'desk.db')
const { chatEnabled, chatStatus, setChatEnabled } = await import('../src/server/chat-availability.server.ts')
const { getDb } = await import('../src/server/db.server.ts')

after(() => fs.rmSync(dir, { recursive: true, force: true }))

const db = getDb()
db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('u1', 'sam@acme.test', 'Sam', 'x', 'admin', '2026-10-29T00:00:00.000Z')").run()
const sam = { id: 'u1', name: 'Sam' }
const auditRows = () => db.prepare('SELECT user_name, action, target FROM admin_audit ORDER BY id').all() as Array<{ user_name: string; action: string; target: string }>

test('the chat is on until someone pauses it', () => {
  assert.equal(chatEnabled(), true)
  assert.deepEqual(chatStatus(), { enabled: true, changedAt: null, changedBy: null })
})

test('pausing and resuming are saved, with who did it, and audited', () => {
  const paused = setChatEnabled(false, sam)
  assert.equal(paused.enabled, false)
  assert.equal(paused.changedBy, 'Sam')
  assert.ok(paused.changedAt)
  assert.equal(chatEnabled(), false)

  const resumed = setChatEnabled(true, sam)
  assert.equal(resumed.enabled, true)
  assert.deepEqual(
    auditRows().map((r) => [r.user_name, r.action, r.target]),
    [
      ['Sam', 'chat.paused', 'chat'],
      ['Sam', 'chat.resumed', 'chat'],
    ],
  )
})

test('setting it to what it already is changes nothing and isn’t audited', () => {
  const before = chatStatus()
  setChatEnabled(true, { id: 'u1', name: 'Someone else' })
  assert.deepEqual(chatStatus(), before)
  assert.equal(auditRows().length, 2)
})
