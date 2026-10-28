import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { openDb } from '../src/server/db.server.ts'
import {
  decryptSecret,
  encryptSecret,
  keyId,
  lastFour,
  readSecret,
  saveSecret,
  scrub,
  secretState,
  SecretError,
  storedSecret,
} from '../src/server/secrets.server.ts'

const KEY = randomBytes(32)
const VALUE = 'shpat_0123456789abcdef0123456789abcdef'

test('a secret round-trips, with a fresh IV each time', () => {
  const a = encryptSecret(KEY, 'shopify', 'admin_token', VALUE)
  const b = encryptSecret(KEY, 'shopify', 'admin_token', VALUE)
  assert.notEqual(a.iv, b.iv)
  assert.notEqual(a.ciphertext, b.ciphertext)
  assert.ok(!a.ciphertext.includes(VALUE))
  assert.equal(decryptSecret(KEY, 'shopify', 'admin_token', a), VALUE)
  assert.equal(a.key_id, keyId(KEY))
  assert.equal(a.last4, 'cdef')
})

test('a different key is reported as "enter it again", not a crash', () => {
  const stored = encryptSecret(KEY, 'shopify', 'admin_token', VALUE)
  assert.throws(() => decryptSecret(randomBytes(32), 'shopify', 'admin_token', stored), (err: unknown) => {
    assert.ok(err instanceof SecretError)
    assert.match((err as Error).message, /different DESK_SECRET_KEY/)
    return true
  })
})

test('tampered ciphertext, tag or IV fails to decrypt', () => {
  const stored = encryptSecret(KEY, 'stripe', 'restricted_key', 'rk_test_abcdefghijklmnop')
  const flip = (b64: string) => {
    const buf = Buffer.from(b64, 'base64')
    buf[0] = buf[0]! ^ 1
    return buf.toString('base64')
  }
  for (const field of ['ciphertext', 'tag', 'iv'] as const) {
    assert.throws(() => decryptSecret(KEY, 'stripe', 'restricted_key', { ...stored, [field]: flip(stored[field]) }), SecretError, field)
  }
})

test('a stored secret only decrypts for its own connector and field', () => {
  const stored = encryptSecret(KEY, 'stripe', 'restricted_key', 'rk_test_abcdefghijklmnop')
  assert.throws(() => decryptSecret(KEY, 'calcom', 'restricted_key', stored), SecretError)
  assert.throws(() => decryptSecret(KEY, 'stripe', 'api_key', stored), SecretError)
})

test('the environment wins over a saved value', () => {
  const db = openDb(':memory:')
  saveSecret(db, KEY, { connector: 'shopify', field: 'admin_token', value: VALUE, userId: null })
  assert.equal(readSecret(db, KEY, { connector: 'shopify', field: 'admin_token', envValue: undefined }), VALUE)
  assert.equal(readSecret(db, KEY, { connector: 'shopify', field: 'admin_token', envValue: 'from-env-token-value' }), 'from-env-token-value')
  assert.deepEqual(secretState(db, KEY, { connector: 'shopify', field: 'admin_token', envValue: 'from-env-token-value' }), {
    set: true,
    source: 'env',
    last4: 'alue',
    stale: false,
  })
})

test('what the dashboard sees never includes the value', () => {
  const db = openDb(':memory:')
  saveSecret(db, KEY, { connector: 'shopify', field: 'admin_token', value: VALUE, userId: null })
  const state = secretState(db, KEY, { connector: 'shopify', field: 'admin_token', envValue: undefined })
  assert.deepEqual(state, { set: true, source: 'dashboard', last4: 'cdef', stale: false })
  assert.ok(!JSON.stringify(state).includes(VALUE.slice(0, -4)))
  // Nothing in the table is the plain value.
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM connector_secrets').all()).includes(VALUE))
})

test('saving again replaces the value; a changed key marks it stale', () => {
  const db = openDb(':memory:')
  saveSecret(db, KEY, { connector: 'shopify', field: 'admin_token', value: VALUE, userId: null })
  saveSecret(db, KEY, { connector: 'shopify', field: 'admin_token', value: 'shpat_new_value_0000000000000000', userId: null })
  assert.equal(db.prepare('SELECT count(*) AS n FROM connector_secrets').get()!.n, 1)
  assert.equal(readSecret(db, KEY, { connector: 'shopify', field: 'admin_token', envValue: undefined }), 'shpat_new_value_0000000000000000')
  const other = randomBytes(32)
  assert.equal(secretState(db, other, { connector: 'shopify', field: 'admin_token', envValue: undefined }).stale, true)
  assert.equal(secretState(db, null, { connector: 'shopify', field: 'admin_token', envValue: undefined }).stale, true)
  assert.throws(() => readSecret(db, null, { connector: 'shopify', field: 'admin_token', envValue: undefined }), /DESK_SECRET_KEY isn’t set/)
  assert.ok(storedSecret(db, 'shopify', 'admin_token'))
})

test('short values show no last four characters', () => {
  assert.equal(lastFour('short'), '')
  assert.equal(lastFour('0123456789ab'), '89ab')
})

test('error text is scrubbed of secret values', () => {
  assert.equal(scrub(`Shopify said: invalid token ${VALUE}`, [VALUE, null, '']), 'Shopify said: invalid token [redacted]')
  // Very short strings aren't treated as secrets (they'd redact ordinary words).
  assert.equal(scrub('a b c', ['a']), 'a b c')
})
