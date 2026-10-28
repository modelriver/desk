import {
  ConnectorError,
  asArray,
  asRecord,
  clean,
  cleanUrl,
  expectOk,
  jsonObject,
  sameEmail,
  send,
  type Connector,
  type ConnectorConfig,
  type ConnectorDeps,
} from './types.ts'

// Stripe: the visitor's subscriptions (plan, price, renewal or end date) and
// recent invoices with their hosted links, found by customer email. Only a
// restricted key is accepted, with read access to Customers, Subscriptions
// and Invoices (Products too, to name plans); a full secret key is refused.
// Card details are never read.

const API = 'https://api.stripe.com/v1'
const RESTRICTED_KEY = /^rk_(?:live|test)_[A-Za-z0-9]{10,}$/
const ZERO_DECIMAL = new Set(['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf'])
const SHOWN_STATUSES = new Set(['active', 'trialing', 'past_due', 'unpaid', 'paused', 'canceled', 'incomplete'])

export function validateStripeKey(value: string): string | null {
  const v = value.trim()
  if (/^sk_/.test(v)) {
    return 'That’s a full secret key, which can change your account. Create a restricted key (rk_…) with read access to Customers, Subscriptions, Invoices and Products.'
  }
  if (/^pk_/.test(v)) return 'That’s a publishable key. Create a restricted key (rk_…) instead.'
  return RESTRICTED_KEY.test(v) ? null : 'Use a restricted key: it starts with rk_live_ or rk_test_.'
}

async function get(config: ConnectorConfig, deps: ConnectorDeps, path: string, params: Array<[string, string]>) {
  const key = config.values.restricted_key ?? ''
  // Checked on every call, not only when saved: a key from the environment skips the form.
  const problem = validateStripeKey(key)
  if (problem) throw new ConnectorError('error', problem)
  const res = await send(deps, 'Stripe', {
    url: `${API}${path}?${new URLSearchParams(params)}`,
    headers: { Authorization: `Bearer ${key}` },
    timeoutMs: 4_000,
    maxBytes: 512 * 1024,
  })
  return jsonObject(expectOk(res, 'Stripe'), 'Stripe')
}

export function formatAmount(amount: unknown, currency: unknown): string | null {
  if (typeof amount !== 'number' || typeof currency !== 'string') return null
  const cur = currency.toLowerCase()
  const value = ZERO_DECIMAL.has(cur) ? String(amount) : (amount / 100).toFixed(2)
  return `${value} ${cur.toUpperCase()}`
}

function date(unixSeconds: unknown): string | null {
  return typeof unixSeconds === 'number' && unixSeconds > 0 ? new Date(unixSeconds * 1000).toISOString().slice(0, 10) : null
}

export function projectSubscription(sub: unknown) {
  const s = asRecord(sub)
  const item = asRecord(asArray(asRecord(s.items).data)[0])
  const price = asRecord(item.price)
  const product = asRecord(price.product)
  const recurring = asRecord(price.recurring)
  const quantity = typeof item.quantity === 'number' ? item.quantity : 1
  const status = clean(s.status, 30)
  // Newer Stripe API versions keep the period on the item.
  const periodEnd = s.current_period_end ?? item.current_period_end
  const amount = formatAmount(price.unit_amount, price.currency)
  const every = recurring.interval_count && recurring.interval_count !== 1 ? `${recurring.interval_count} ${recurring.interval}s` : recurring.interval
  return {
    status,
    plan: clean(product.name, 80) ?? clean(price.nickname, 80),
    price: amount ? `${amount}${every ? ` per ${clean(every, 20)}` : ''}${quantity > 1 ? ` × ${quantity}` : ''}` : null,
    renews: !s.cancel_at_period_end && (status === 'active' || status === 'trialing') ? date(periodEnd) : null,
    endsOn: s.cancel_at_period_end ? (date(s.cancel_at) ?? date(periodEnd)) : null,
    trialEnds: status === 'trialing' ? date(s.trial_end) : null,
    canceledOn: status === 'canceled' ? date(s.canceled_at ?? s.ended_at) : null,
  }
}

export function projectInvoice(inv: unknown) {
  const i = asRecord(inv)
  return {
    number: clean(i.number, 40),
    date: date(i.created),
    amount: formatAmount(i.status === 'paid' ? i.amount_paid : i.amount_due, i.currency),
    status: clean(i.status, 20),
    link: cleanUrl(i.hosted_invoice_url),
  }
}

async function subscriptionsFor(config: ConnectorConfig, deps: ConnectorDeps, customer: string) {
  const base: Array<[string, string]> = [
    ['customer', customer],
    ['status', 'all'],
    ['limit', '5'],
  ]
  try {
    return asArray((await get(config, deps, '/subscriptions', [...base, ['expand[]', 'data.items.data.price.product']])).data)
  } catch (err) {
    // Without read access to Products the plan is named by its price nickname.
    if (err instanceof ConnectorError && err.kind === 'forbidden') return asArray((await get(config, deps, '/subscriptions', base)).data)
    throw err
  }
}

export const stripe: Connector = {
  id: 'stripe',
  label: 'Stripe',
  description: 'Subscription, plan, renewal date and recent invoices for the visitor.',
  setupUrl: 'https://dashboard.stripe.com/apikeys',
  fields: [
    {
      name: 'restricted_key',
      label: 'Restricted key',
      secret: true,
      env: 'STRIPE_RESTRICTED_KEY',
      required: true,
      placeholder: 'rk_live_…',
      hint: 'Read access to Customers, Subscriptions, Invoices and Products; nothing else.',
      validate: validateStripeKey,
    },
  ],
  options: [{ name: 'include_invoices', label: 'Recent invoices with their links', default: true }],
  topics: () =>
    /\b(?:bill(?:ing|ed)?|invoices?|receipts?|subscri\w*|plans?|charge[sd]?|payments?|paid|pay|renew\w*|cancel\w*|upgrade\w*|downgrade\w*|trial|refunds?|card)\b/i,

  async test(config, deps) {
    const mode = (config.values.restricted_key ?? '').startsWith('rk_test_') ? 'test mode' : 'live mode'
    for (const [path, name] of [
      ['/customers', 'Customers'],
      ['/subscriptions', 'Subscriptions'],
      ['/invoices', 'Invoices'],
    ] as const) {
      try {
        await get(config, deps, path, [['limit', '1']])
      } catch (err) {
        if (err instanceof ConnectorError && err.kind === 'forbidden') {
          return { ok: false, detail: `The key can’t read ${name}. Give it Read access to ${name} in Stripe.` }
        }
        throw err
      }
    }
    return { ok: true, detail: `Connected with a restricted key (${mode}).` }
  },

  async lookup(config, input, deps) {
    const customers = asArray((await get(config, deps, '/customers', [['email', input.email], ['limit', '10']])).data)
      // Stripe's email filter is exact but case-sensitive; checked here either way.
      .filter((c) => sameEmail(asRecord(c).email, input.email))
      .slice(0, 3)
    if (!customers.length) return { status: 'not_found', summary: 'no customer with this email' }

    const subscriptions: unknown[] = []
    const invoices: unknown[] = []
    for (const c of customers) {
      const id = String(asRecord(c).id ?? '')
      if (!/^cus_[A-Za-z0-9]+$/.test(id)) continue
      subscriptions.push(...(await subscriptionsFor(config, deps, id)).filter((s) => SHOWN_STATUSES.has(String(asRecord(s).status))))
      if (config.options.include_invoices !== false) {
        invoices.push(...asArray((await get(config, deps, '/invoices', [['customer', id], ['limit', '3']])).data))
      }
    }
    const subs = subscriptions
      .map(projectSubscription)
      .sort((a, b) => Number(b.status !== 'canceled') - Number(a.status !== 'canceled'))
      .slice(0, 3)
    const recent = invoices
      .map(projectInvoice)
      .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
      .slice(0, 3)
    const data: Record<string, unknown> = { subscriptions: subs }
    if (config.options.include_invoices !== false) data.invoices = recent
    return {
      status: 'ok',
      summary: subs.length ? `${subs.length} subscription${subs.length === 1 ? '' : 's'}` : 'a customer with no subscriptions',
      data,
    }
  },
}
