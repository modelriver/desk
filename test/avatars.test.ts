import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// The database path is read when the modules first load, so point it at a
// throwaway file before loading them.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-avatars-'))
process.env.DATABASE_PATH = path.join(dir, 'desk.db')
const { avatarOf, avatarResponse, avatarsByName, MAX_AVATAR_BYTES, removeAvatar, saveAvatar } = await import('../src/server/avatars.server.ts')
const { getDb } = await import('../src/server/db.server.ts')

after(() => fs.rmSync(dir, { recursive: true, force: true }))

const db = getDb()
const addUser = (id: string, name: string) =>
  db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, 'x', 'agent', '2026-10-31T00:00:00.000Z')").run(id, `${id}@acme.test`, name)
addUser('u1', 'Sam')
addUser('u2', 'Lee')
addUser('u3', 'Lee')

// The first bytes of each format are all the server looks at.
const webp = () => new Uint8Array([...new TextEncoder().encode('RIFF'), 0, 0, 0, 0, ...new TextEncoder().encode('WEBPVP8 '), 1, 2, 3])
const jpeg = () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
const gif = () => new TextEncoder().encode('GIF89a......')
const svg = () => new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')

test('a PNG, JPEG or WebP picture is saved and served by its hash', async () => {
  const url = saveAvatar('u1', webp())
  assert.match(url, /^\/avatars\/[a-f0-9]{24}$/)
  assert.equal(avatarOf('u1'), url)
  const res = avatarResponse(url.split('/').pop()!)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'image/webp')
  assert.match(res.headers.get('cache-control')!, /immutable/)
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), webp())
})

test('anything else, or too large, is refused', () => {
  assert.throws(() => saveAvatar('u2', gif()), /PNG, JPEG or WebP/)
  assert.throws(() => saveAvatar('u2', svg()), /PNG, JPEG or WebP/)
  const big = new Uint8Array(MAX_AVATAR_BYTES + 1)
  big.set(jpeg())
  assert.throws(() => saveAvatar('u2', big), /too large/)
  assert.equal(avatarOf('u2'), null)
})

test('a new picture replaces the old one, whose address stops working', () => {
  const old = avatarOf('u1')!
  const next = saveAvatar('u1', jpeg())
  assert.notEqual(next, old)
  assert.equal(avatarResponse(old.split('/').pop()!).status, 404)
  assert.equal(avatarResponse(next.split('/').pop()!).headers.get('content-type'), 'image/jpeg')
})

test('pictures by name skip a name two people share', () => {
  saveAvatar('u2', webp())
  const map = avatarsByName(['Sam', 'Lee', 'Nobody', ''])
  assert.equal(map.get('Sam'), avatarOf('u1'))
  assert.equal(map.has('Lee'), false, 'two people are called Lee: no picture rather than the wrong one')
  assert.equal(map.size, 1)
})

test('removing a picture, or the person, removes it', () => {
  removeAvatar('u1')
  assert.equal(avatarOf('u1'), null)
  db.prepare("DELETE FROM users WHERE id = 'u2'").run()
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM user_avatars WHERE user_id = 'u2'").get()!.n, 0)
  assert.equal(avatarResponse('not-a-hash').status, 404)
})
