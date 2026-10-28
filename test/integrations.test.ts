import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { openDb } from '../src/server/db.server.ts'
import { resetRateLimits } from '../src/server/rate-limit.server.ts'
import { SafeHttpError } from '../src/server/safe-http.server.ts'
import { storedSecret } from '../src/server/secrets.server.ts'
import {
  auditLog,
  connectorById,
  connectorView,
  forgetCachedLookups,
  loadConfig,
  lookupHints,
  maskEmail,
  recentEvents,
  relevantConnectors,
  runLookups,
  saveConnector,
  testConnector,
  type IntegrationsEnv,
} from '../src/server/integrations.server.ts'
import { assertAbsent, fakeHttp, path } from './connector-helpers.ts'

const KEY = randomBytes(32)
const STRIPE_KEY = 'rk_test_51ABCdefGHIjklMNOpq'
const SHOPIFY_TOKEN = `shpat_${'b'.repeat(32)}`
const admin = { id: 'u1', name: 'Ada Admin' }
const env = (vars: Record<string, string> = {}, secretKey: Buffer | null = KEY): IntegrationsEnv => ({ secretKey, allowPrivate: false, vars })

beforeEach(() => {
  resetRateLimits()
  forgetCachedLookups()
})

function db() {
  const conn = openDb(':memory:')
  conn.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('u1', 'ada@example.com', 'Ada Admin', 'h', 'admin', 'now')").run()
  conn.prepare("INSERT INTO conversations (id, visitor_token_hash, mode, created_at, last_activity_at) VALUES ('c1', 'h', 'ai', 'now', 'now')").run()
  return conn
}

function withStripe(conn = db()) {
  saveConnector(conn, { id: 'stripe', enabled: true, values: { restricted_key: STRIPE_KEY }, clear: [], options: {} }, admin, env())
  return conn
}

const stripeApi = () =>
  fakeHttp([
    [path('/v1/customers'), () => ({ json: { data: [{ id: 'cus_1', email: 'sam@example.com', invoice_settings: { default_payment_method: { card: { last4: '4242' } } } }] } })],
    [path('/v1/subscriptions'), () => ({ json: { data: [{ status: 'active', items: { data: [{ price: { unit_amount: 900, currency: 'usd', nickname: 'Solo', recurring: { interval: 'month' } } }] } }] } })],
    [path('/v1/invoices'), () => ({ json: { data: [] } })],
  ])

const lookup = (conn: ReturnType<typeof db>, request: ReturnType<typeof fakeHttp>['request'], question = 'when does my plan renew?', ip = '203.0.113.9') =>
  runLookups(conn, { conversationId: 'c1', email: 'sam@example.com', question, ip, connectors: relevantConnectors(conn, { text: question, conversationId: 'c1' }, env()) }, { request }, env())

test('a key is saved encrypted and the connector turned on, with an audit trail', () => {
  const conn = withStripe()
  const view = connectorView(conn, connectorById('stripe')!, env())
  assert.equal(view.enabled, true)
  assert.equal(view.ready, true)
  assertAbsent(view, [STRIPE_KEY])
  assert.deepEqual(view.fields[0], {
    name: 'restricted_key',
    label: 'Restricted key',
    env: 'STRIPE_RESTRICTED_KEY',
    required: true,
    placeholder: 'rk_live_…',
    hint: 'Read access to Customers, Subscriptions, Invoices and Products; nothing else.',
    secret: true,
    state: { set: true, source: 'dashboard', last4: 'NOpq', stale: false },
  })
  assert.equal(loadConfig(conn, connectorById('stripe')!, env()).config.values.restricted_key, STRIPE_KEY)
  assert.deepEqual(
    auditLog(conn).map((a) => [a.user, a.action, a.target]),
    [
      ['Ada Admin', 'connector.enabled', 'stripe'],
      ['Ada Admin', 'connector.key_saved', 'stripe.restricted_key'],
    ],
  )
})

test('keys can’t be saved here without DESK_SECRET_KEY', () => {
  const conn = db()
  assert.throws(
    () => saveConnector(conn, { id: 'stripe', enabled: false, values: { restricted_key: STRIPE_KEY }, clear: [], options: {} }, admin, env({}, null)),
    /DESK_SECRET_KEY/,
  )
  assert.equal(storedSecret(conn, 'stripe', 'restricted_key'), null)
})

test('invalid values are refused with the field’s own message', () => {
  const conn = db()
  assert.throws(
    () => saveConnector(conn, { id: 'stripe', enabled: false, values: { restricted_key: 'sk_live_51ABCdefGHIjklMNO' }, clear: [], options: {} }, admin, env()),
    /^Error: Restricted key: That’s a full secret key/,
  )
  assert.throws(
    () => saveConnector(conn, { id: 'shopify', enabled: false, values: { shop_domain: 'internal.corp' }, clear: [], options: {} }, admin, env()),
    /Shop domain: Use your \.myshopify\.com domain/,
  )
  assert.throws(() => saveConnector(conn, { id: 'stripe', enabled: false, values: { nope: 'x' }, clear: [], options: {} }, admin, env()), /Unknown field/)
  assert.throws(() => saveConnector(conn, { id: 'stripe', enabled: false, values: {}, clear: [], options: { nope: true } }, admin, env()), /Unknown option/)
  assert.throws(() => saveConnector(conn, { id: 'nope', enabled: false, values: {}, clear: [], options: {} }, admin, env()), /Unknown connector/)
  assert.equal(auditLog(conn).length, 0)
})

test('turning on without every required field fails and saves nothing', () => {
  const conn = db()
  assert.throws(
    () => saveConnector(conn, { id: 'shopify', enabled: true, values: { admin_token: SHOPIFY_TOKEN }, clear: [], options: {} }, admin, env()),
    /Add Shop domain before turning Shopify on/,
  )
  assert.equal(storedSecret(conn, 'shopify', 'admin_token'), null)
  assert.equal(auditLog(conn).length, 0)
})

test('values set in the environment win and aren’t overwritten from the dashboard', () => {
  const conn = db()
  const e = env({ STRIPE_RESTRICTED_KEY: 'rk_live_FROMENVIRONMENT1' })
  saveConnector(conn, { id: 'stripe', enabled: true, values: { restricted_key: 'rk_test_typedinthedashboard' }, clear: [], options: {} }, admin, e)
  assert.equal(storedSecret(conn, 'stripe', 'restricted_key'), null)
  assert.equal(loadConfig(conn, connectorById('stripe')!, e).config.values.restricted_key, 'rk_live_FROMENVIRONMENT1')
  const field = connectorView(conn, connectorById('stripe')!, e).fields[0]!
  assert.ok(field.secret && field.state.source === 'env')
  assertAbsent(connectorView(conn, connectorById('stripe')!, e), ['FROMENVIRONMENT'])
})

test('options are stored and plain fields cleared; a cleared required field makes it not ready', () => {
  const conn = db()
  saveConnector(
    conn,
    { id: 'shopify', enabled: true, values: { shop_domain: 'acme.myshopify.com', admin_token: SHOPIFY_TOKEN }, clear: [], options: { include_items: false } },
    admin,
    env(),
  )
  assert.equal(loadConfig(conn, connectorById('shopify')!, env()).config.options.include_items, false)
  assert.equal(loadConfig(conn, connectorById('shopify')!, env()).config.options.include_tracking, true)
  saveConnector(conn, { id: 'shopify', enabled: false, values: {}, clear: ['shop_domain'], options: {} }, admin, env())
  const view = connectorView(conn, connectorById('shopify')!, env())
  assert.equal(view.ready, false)
  assert.deepEqual(view.missing, ['Shop domain'])
})

test('only enabled, ready connectors about the question are used', () => {
  const conn = withStripe()
  const ids = (text: string) => relevantConnectors(conn, { text, conversationId: 'c1' }, env()).map((c) => c.id)
  assert.deepEqual(ids('I was charged twice'), ['stripe'])
  assert.deepEqual(ids('How do I export a report?'), [])
  saveConnector(conn, { id: 'stripe', enabled: false, values: {}, clear: [], options: {} }, admin, env())
  assert.deepEqual(ids('I was charged twice'), [])
})

test('once a service was looked up in a chat, follow-ups use it without the keywords', async () => {
  const conn = withStripe()
  await lookup(conn, stripeApi().request)
  assert.deepEqual(
    relevantConnectors(conn, { text: 'and how much was it?', conversationId: 'c1' }, env()).map((c) => c.id),
    ['stripe'],
  )
})

test('a lookup returns the data and records who was looked up, masked, without the data', async () => {
  const conn = withStripe()
  const results = await lookup(conn, stripeApi().request)
  assert.equal(results.length, 1)
  assert.equal(results[0]!.status, 'ok')
  assert.equal(results[0]!.summary, '1 subscription')
  const [event] = recentEvents(conn)
  assert.equal(event!.subject, 's***@example.com')
  assert.equal(event!.status, 'ok')
  assert.equal(event!.detail, '1 subscription')
  assertAbsent(conn.prepare('SELECT * FROM connector_events').all(), ['sam@example.com', 'Solo', '4242'])
  assertAbsent(results, ['4242'])
})

test('lookups are cached briefly per conversation', async () => {
  const conn = withStripe()
  const http = stripeApi()
  await lookup(conn, http.request)
  const calls = http.calls.length
  await lookup(conn, http.request)
  assert.equal(http.calls.length, calls)
  forgetCachedLookups()
  await lookup(conn, http.request)
  assert.ok(http.calls.length > calls)
})

test('a failing service is reported as unavailable, with secrets scrubbed from the record', async () => {
  const conn = withStripe()
  const request = async () => {
    throw new SafeHttpError('network', `upstream said bad key ${STRIPE_KEY}`)
  }
  const [result] = await lookup(conn, request)
  assert.deepEqual(result, { connector: 'stripe', label: 'Stripe', status: 'unavailable', summary: 'unavailable right now' })
  const [event] = recentEvents(conn)
  assert.equal(event!.status, 'error')
  assert.ok(!event!.detail.includes(STRIPE_KEY))
  assert.match(event!.detail, /\[redacted\]/)
})

test('one service failing doesn’t stop the others', async () => {
  const conn = withStripe()
  saveConnector(
    conn,
    { id: 'shopify', enabled: true, values: { shop_domain: 'acme.myshopify.com', admin_token: SHOPIFY_TOKEN }, clear: [], options: {} },
    admin,
    env(),
  )
  const stripe = stripeApi()
  const request = async (req: Parameters<typeof stripe.request>[0]) => {
    if (req.url.includes('myshopify')) return { status: 503, text: '', json: undefined }
    return stripe.request(req)
  }
  const results = await lookup(conn, request, 'my order was charged twice')
  assert.deepEqual(
    results.map((r) => [r.connector, r.status]),
    [
      ['shopify', 'unavailable'],
      ['stripe', 'ok'],
    ],
  )
})

test('lookups are rate-limited per conversation and per IP', async () => {
  const conn = withStripe()
  const { request } = stripeApi()
  for (let i = 0; i < 10; i++) {
    forgetCachedLookups()
    assert.equal((await lookup(conn, request))[0]!.status, 'ok')
  }
  assert.equal((await lookup(conn, request))[0]!.status, 'rate_limited')
  assert.equal(recentEvents(conn)[0]!.status, 'rate_limited')

  resetRateLimits()
  conn.prepare("INSERT INTO conversations (id, visitor_token_hash, mode, created_at, last_activity_at) VALUES ('c2', 'h', 'ai', 'now', 'now')").run()
  // 30 per IP across conversations.
  let limited = 0
  for (let i = 0; i < 35; i++) {
    forgetCachedLookups()
    const conversationId = i % 2 ? 'c1' : 'c2'
    const connectors = relevantConnectors(conn, { text: 'invoice', conversationId }, env())
    const [r] = await runLookups(conn, { conversationId, email: 'sam@example.com', question: 'invoice', ip: '198.51.100.1', connectors }, { request }, env())
    if (r!.status === 'rate_limited') limited++
  }
  assert.ok(limited >= 5, `limited ${limited}`)
})

test('lookup records older than 30 days are removed', async () => {
  const conn = withStripe()
  conn
    .prepare("INSERT INTO connector_events (conversation_id, connector, subject_masked, status, created_at) VALUES ('c1', 'stripe', 'o***@x.com', 'ok', ?)")
    .run(new Date(Date.now() - 31 * 86_400_000).toISOString())
  await lookup(conn, stripeApi().request)
  assert.equal(recentEvents(conn).length, 1)
})

test('the widget learns which words trigger a lookup, but never any key', () => {
  const conn = db()
  assert.deepEqual(lookupHints(conn, env()), { enabled: false, always: false, patterns: [] })
  withStripe(conn)
  const hints = lookupHints(conn, env())
  assert.equal(hints.enabled, true)
  assert.equal(hints.always, false)
  assert.ok(new RegExp(hints.patterns[0]!, 'i').test('my invoice'))
  assertAbsent(hints, [STRIPE_KEY])
})

test('the connection test reports missing settings before calling anything', async () => {
  const conn = db()
  const http = fakeHttp([])
  assert.deepEqual(await testConnector(conn, 'stripe', { request: http.request }, env()), { ok: false, detail: 'Add Restricted key first.' })
  assert.equal(http.calls.length, 0)
  withStripe(conn)
  assert.deepEqual(await testConnector(conn, 'stripe', { request: stripeApi().request }, env()), { ok: true, detail: 'Connected with a restricted key (test mode).' })
})

test('emails are masked to their first letter and domain', () => {
  assert.equal(maskEmail('sam@example.com'), 's***@example.com')
  assert.equal(maskEmail('weird'), '***')
})

test('Custom HTTP goes by the name the admin gave it', async () => {
  const conn = db()
  saveConnector(
    conn,
    { id: 'custom_http', enabled: true, values: { url: 'https://api.example.com/lookup', signing_secret: 's'.repeat(40), name: 'Licences', topics: 'seats' }, clear: [], options: {} },
    admin,
    env(),
  )
  const http = fakeHttp([[() => true, () => ({ json: { facts: [{ label: 'Seats', value: '12' }] } })]])
  const [result] = await lookup(conn, http.request, 'how many seats?')
  assert.equal(result!.label, 'Licences')
  saveConnector(conn, { id: 'custom_http', enabled: true, values: {}, clear: ['name'], options: {} }, admin, env())
  assert.equal(relevantConnectors(conn, { text: 'seats', conversationId: 'c1' }, env())[0]!.displayName!(loadConfig(conn, connectorById('custom_http')!, env()).config), 'Custom HTTP')
})
