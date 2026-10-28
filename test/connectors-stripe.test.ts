import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatAmount, projectSubscription, stripe, validateStripeKey } from '../src/server/connectors/stripe.server.ts'
import type { ConnectorConfig } from '../src/server/connectors/types.ts'
import { assertAbsent, failsWith, fakeHttp, path } from './connector-helpers.ts'

const KEY = 'rk_test_51ABCdefGHIjklMNO'
const config = (options: Record<string, boolean> = {}, key = KEY): ConnectorConfig => ({
  values: { restricted_key: key },
  options: { include_invoices: true, ...options },
  allowPrivate: false,
})
const input = { email: 'sam@example.com', question: 'when does my plan renew?', conversationId: 'c1' }

const customer = {
  id: 'cus_123',
  email: 'sam@example.com',
  // Never shown to the AI:
  address: { line1: '1 Secret Street' },
  phone: '+1 555 0100',
  invoice_settings: { default_payment_method: { card: { last4: '4242', exp_year: 2030 } } },
}

const subscription = {
  id: 'sub_1',
  status: 'active',
  cancel_at_period_end: false,
  current_period_end: 1798761600, // 2027-01-01
  items: { data: [{ quantity: 1, price: { unit_amount: 2900, currency: 'usd', nickname: 'Team monthly', recurring: { interval: 'month', interval_count: 1 }, product: { name: 'Team' } } }] },
  default_payment_method: { card: { last4: '4242' } },
}

const invoice = {
  number: 'INV-0001',
  created: 1793491200,
  amount_paid: 2900,
  amount_due: 2900,
  currency: 'usd',
  status: 'paid',
  hosted_invoice_url: 'https://invoice.stripe.com/i/acct_1/test',
  charge: { payment_method_details: { card: { last4: '4242' } } },
}

function stripeApi(overrides: { subscriptions?: (url: URL) => { status?: number; json?: unknown } } = {}) {
  return fakeHttp([
    [path('/v1/customers'), () => ({ json: { data: [customer, { ...customer, id: 'cus_999', email: 'other@example.com' }] } })],
    [path('/v1/subscriptions'), (_r, url) => overrides.subscriptions?.(url) ?? { json: { data: [subscription] } }],
    [path('/v1/invoices'), () => ({ json: { data: [invoice] } })],
  ])
}

test('only restricted keys are accepted', () => {
  assert.equal(validateStripeKey(KEY), null)
  assert.equal(validateStripeKey('rk_live_51ABCdefGHIjklMNO'), null)
  assert.match(validateStripeKey('sk_live_51ABCdefGHIjklMNO')!, /full secret key/)
  assert.match(validateStripeKey('sk_test_51ABCdefGHIjklMNO')!, /full secret key/)
  assert.match(validateStripeKey('pk_live_51ABCdefGHIjklMNO')!, /publishable/)
  assert.ok(validateStripeKey('rk_live_short'))
})

test('a full secret key from the environment is refused before any request', async () => {
  const http = stripeApi()
  await assert.rejects(stripe.lookup(config({}, 'sk_live_51ABCdefGHIjklMNO'), input, http), failsWith('error', /full secret key/))
  assert.equal(http.calls.length, 0)
})

test('looks up subscriptions and invoices for the verified email, without card data', async () => {
  const http = stripeApi()
  const result = await stripe.lookup(config(), input, http)
  assert.ok(result.status === 'ok')
  assert.equal(result.summary, '1 subscription')
  assert.deepEqual(result.data, {
    subscriptions: [{ status: 'active', plan: 'Team', price: '29.00 USD per month', renews: '2027-01-01', endsOn: null, trialEnds: null, canceledOn: null }],
    invoices: [{ number: 'INV-0001', date: '2026-11-01', amount: '29.00 USD', status: 'paid', link: 'https://invoice.stripe.com/i/acct_1/test' }],
  })
  assertAbsent(result, ['4242', 'Secret Street', '555 0100', 'cus_999', KEY])
  // The key goes in the Authorization header, never the URL.
  for (const call of http.calls) {
    assert.equal(call.headers!.Authorization, `Bearer ${KEY}`)
    assert.ok(!call.url.includes(KEY))
  }
  assert.equal(http.calls[0]!.parsed.searchParams.get('email'), 'sam@example.com')
  // Only the matching customer was queried further.
  assert.ok(http.calls.filter((c) => c.parsed.pathname !== '/v1/customers').every((c) => c.parsed.searchParams.get('customer') === 'cus_123'))
})

test('without read access to Products, plans are named by their price nickname', async () => {
  const http = stripeApi({
    subscriptions: (url) => (url.searchParams.has('expand[]') ? { status: 403, json: {} } : { json: { data: [{ ...subscription, items: { data: [{ ...subscription.items.data[0], price: { ...subscription.items.data[0]!.price, product: 'prod_1' } }] } }] } }),
  })
  const result = await stripe.lookup(config(), input, http)
  assert.ok(result.status === 'ok')
  assert.equal((result.data as any).subscriptions[0].plan, 'Team monthly')
})

test('no customer with that exact email means nothing found', async () => {
  const http = fakeHttp([[path('/v1/customers'), () => ({ json: { data: [{ ...customer, email: 'sam@example.co' }] } })]])
  assert.deepEqual(await stripe.lookup(config(), input, http), { status: 'not_found', summary: 'no customer with this email' })
})

test('invoices can be left out', async () => {
  const http = stripeApi()
  const result = await stripe.lookup(config({ include_invoices: false }), input, http)
  assert.ok(result.status === 'ok')
  assert.equal('invoices' in (result.data as object), false)
  assert.ok(!http.calls.some((c) => c.parsed.pathname === '/v1/invoices'))
})

test('subscriptions show renewal, end, trial and cancellation dates', () => {
  // Newer Stripe API versions put the period on the item.
  const onItem = projectSubscription({ ...subscription, current_period_end: undefined, items: { data: [{ ...subscription.items.data[0], current_period_end: 1798761600 }] } })
  assert.equal(onItem.renews, '2027-01-01')
  const ending = projectSubscription({ ...subscription, cancel_at_period_end: true, cancel_at: 1798761600 })
  assert.equal(ending.renews, null)
  assert.equal(ending.endsOn, '2027-01-01')
  const trial = projectSubscription({ ...subscription, status: 'trialing', trial_end: 1798761600 })
  assert.equal(trial.trialEnds, '2027-01-01')
  const canceled = projectSubscription({ ...subscription, status: 'canceled', canceled_at: 1798761600 })
  assert.equal(canceled.canceledOn, '2027-01-01')
  assert.equal(canceled.renews, null)
  const yearlySeats = projectSubscription({
    ...subscription,
    items: { data: [{ quantity: 5, price: { unit_amount: 10000, currency: 'eur', recurring: { interval: 'year', interval_count: 1 }, product: { name: 'Pro' } } }] },
  })
  assert.equal(yearlySeats.price, '100.00 EUR per year × 5')
})

test('zero-decimal currencies aren’t divided by 100', () => {
  assert.equal(formatAmount(2900, 'usd'), '29.00 USD')
  assert.equal(formatAmount(1500, 'jpy'), '1500 JPY')
  assert.equal(formatAmount(undefined, 'usd'), null)
})

test('the connection test names the missing permission', async () => {
  const http = fakeHttp([
    [path('/v1/customers'), () => ({ json: { data: [] } })],
    [path('/v1/subscriptions'), () => ({ json: { data: [] } })],
    [path('/v1/invoices'), () => ({ status: 403, json: {} })],
  ])
  assert.deepEqual(await stripe.test(config(), http), { ok: false, detail: 'The key can’t read Invoices. Give it Read access to Invoices in Stripe.' })
  const ok = await stripe.test(config(), stripeApi())
  assert.deepEqual(ok, { ok: true, detail: 'Connected with a restricted key (test mode).' })
})

test('a rejected key and rate limits are reported clearly', async () => {
  await assert.rejects(stripe.lookup(config(), input, fakeHttp([[path('/v1/customers'), () => ({ status: 401, json: {} })]])), failsWith('rejected'))
  await assert.rejects(stripe.lookup(config(), input, fakeHttp([[path('/v1/customers'), () => ({ status: 429, json: {} })]])), failsWith('rate_limited'))
})

test('billing questions match the topic', () => {
  const topics = stripe.topics(config())!
  for (const q of ['When does my subscription renew?', 'I was charged twice', 'send me my invoice', 'cancel my plan']) assert.ok(topics.test(q), q)
  assert.ok(!topics.test('How do I export my data?'))
})
