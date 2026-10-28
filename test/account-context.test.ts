import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { openDb } from '../src/server/db.server.ts'
import { resetRateLimits } from '../src/server/rate-limit.server.ts'
import { accountContext, NO_ACCOUNT } from '../src/server/account-context.server.ts'
import { forgetCachedLookups, saveConnector, type IntegrationsEnv } from '../src/server/integrations.server.ts'
import { fakeHttp, path } from './connector-helpers.ts'

const e: IntegrationsEnv = { secretKey: randomBytes(32), allowPrivate: false, vars: {} }

beforeEach(() => {
  resetRateLimits()
  forgetCachedLookups()
})

function db() {
  const conn = openDb(':memory:')
  conn.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('u1', 'a@example.com', 'A', 'h', 'admin', 'now')").run()
  conn.prepare("INSERT INTO conversations (id, visitor_token_hash, mode, created_at, last_activity_at) VALUES ('c1', 'h', 'ai', 'now', 'now')").run()
  saveConnector(conn, { id: 'stripe', enabled: true, values: { restricted_key: 'rk_test_51ABCdefGHIjklMNO' }, clear: [], options: {} }, { id: 'u1', name: 'A' }, e)
  return conn
}

const api = () =>
  fakeHttp([
    [path('/v1/customers'), () => ({ json: { data: [{ id: 'cus_1', email: 'sam@example.com' }] } })],
    [path('/v1/subscriptions'), () => ({ json: { data: [] } })],
    [path('/v1/invoices'), () => ({ json: { data: [] } })],
  ])

const conv = (overrides: Partial<{ mode: 'ai' | 'human'; verified_email: string | null }> = {}) => ({ id: 'c1', mode: 'ai' as const, verified_email: null, ...overrides })

test('an account question from an unverified visitor asks them to verify, and looks nothing up', async () => {
  const http = api()
  const ctx = await accountContext(db(), { conversation: conv(), text: 'where is my invoice?', ip: '1.2.3.4', waiting: false, canVerify: true }, http, e)
  assert.deepEqual(ctx.verify, { services: ['Stripe'], expired: false })
  assert.match(ctx.message!, /haven’t verified their email/)
  assert.match(ctx.message!, /Never ask them to type a code/)
  assert.deepEqual(ctx.checked, [])
  assert.equal(http.calls.length, 0)
})

test('without email codes, the AI is told lookups aren’t available and no card is shown', async () => {
  const ctx = await accountContext(db(), { conversation: conv(), text: 'my invoice', ip: '1.2.3.4', waiting: false, canVerify: false }, api(), e)
  assert.equal(ctx.verify, null)
  assert.match(ctx.message!, /aren’t available in this chat/)
})

test('a verified visitor’s question is looked up and the data added for the AI', async () => {
  const http = api()
  const ctx = await accountContext(db(), { conversation: conv({ verified_email: 'sam@example.com' }), text: 'my invoice', ip: '1.2.3.4', waiting: false }, http, e)
  assert.equal(ctx.verify, null)
  assert.deepEqual(ctx.checked, ['Stripe'])
  assert.match(ctx.message!, /<account_data>/)
  assert.match(ctx.message!, /"Stripe"/)
  assert.ok(http.calls.length > 0)
})

test('nothing happens when the team has the chat, the visitor is waiting, or the question isn’t about an account', async () => {
  const conn = db()
  const http = api()
  const base = { ip: '1.2.3.4', canVerify: true }
  assert.deepEqual(await accountContext(conn, { ...base, conversation: conv({ mode: 'human', verified_email: 'sam@example.com' }), text: 'my invoice', waiting: false }, http, e), NO_ACCOUNT)
  assert.deepEqual(await accountContext(conn, { ...base, conversation: conv({ verified_email: 'sam@example.com' }), text: 'my invoice', waiting: true }, http, e), NO_ACCOUNT)
  assert.deepEqual(await accountContext(conn, { ...base, conversation: conv({ verified_email: 'sam@example.com' }), text: 'what are your hours?', waiting: false }, http, e), NO_ACCOUNT)
  assert.equal(http.calls.length, 0)
})

test('a lapsed verification asks the visitor to verify again, saying why', async () => {
  const http = api()
  const ctx = await accountContext(
    db(),
    { conversation: conv(), text: 'my invoice', ip: '1.2.3.4', waiting: false, canVerify: true, verificationExpired: true },
    http,
    e,
  )
  assert.deepEqual(ctx.verify, { services: ['Stripe'], expired: true })
  assert.match(ctx.message!, /verification has expired/)
  assert.match(ctx.message!, /verify again/)
  assert.equal(http.calls.length, 0)
})
