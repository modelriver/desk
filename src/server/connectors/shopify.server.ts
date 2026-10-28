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

// Shopify: the visitor's recent orders (status, items, tracking), found by
// the email on the order. Uses a custom app's Admin API access token with
// read_orders only; a token that can write anything is refused.
// Without the read_all_orders scope Shopify only returns the last 60 days of orders.

export const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-04'
const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]{0,60}\.myshopify\.com$/
const MAX_ORDERS = 5

function shopDomain(config: ConnectorConfig): string {
  const shop = (config.values.shop_domain ?? '').trim().toLowerCase()
  if (!SHOP_DOMAIN.test(shop)) throw new ConnectorError('error', 'The shop domain must look like your-store.myshopify.com.')
  return shop
}

function headers(config: ConnectorConfig): Record<string, string> {
  return { 'X-Shopify-Access-Token': config.values.admin_token ?? '', 'content-type': 'application/json' }
}

// "#1234", "order 1234", "order number 1234": the order the visitor means, if any.
export function orderNumberIn(text: string): string | null {
  const m = /#\s?(\d{1,12})\b/.exec(text) ?? /\border\s+(?:number\s+|no\.?\s*|num\.?\s*)?(\d{3,12})\b/i.exec(text)
  return m ? m[1]! : null
}

const ORDERS_QUERY = `query DeskOrders($q: String!, $first: Int!) {
  orders(first: $first, sortKey: CREATED_AT, reverse: true, query: $q) {
    nodes {
      name
      email
      createdAt
      cancelledAt
      displayFinancialStatus
      displayFulfillmentStatus
      statusPageUrl
      currentTotalPriceSet { shopMoney { amount currencyCode } }
      lineItems(first: 10) { nodes { title quantity } }
      fulfillments(first: 5) { displayStatus trackingInfo(first: 3) { company number url } }
    }
  }
}`

function readable(status: unknown): string | null {
  const text = clean(status, 40)
  return text ? text.toLowerCase().replace(/_/g, ' ') : null
}

export function projectOrder(node: unknown, options: ConnectorConfig['options']) {
  const o = asRecord(node)
  const money = asRecord(asRecord(asRecord(o.currentTotalPriceSet).shopMoney))
  const order: Record<string, unknown> = {
    number: clean(o.name, 30),
    placed: typeof o.createdAt === 'string' ? o.createdAt.slice(0, 10) : null,
    cancelled: typeof o.cancelledAt === 'string',
    payment: readable(o.displayFinancialStatus),
    fulfillment: readable(o.displayFulfillmentStatus),
    total: money.amount ? `${clean(money.amount, 20)} ${clean(money.currencyCode, 3) ?? ''}`.trim() : null,
    orderStatusPage: cleanUrl(o.statusPageUrl),
  }
  if (options.include_items !== false) {
    order.items = asArray(asRecord(o.lineItems).nodes)
      .slice(0, 10)
      .map((li) => ({ title: clean(asRecord(li).title, 120), quantity: Number(asRecord(li).quantity) || 0 }))
  }
  if (options.include_tracking !== false) {
    order.shipments = asArray(o.fulfillments)
      .slice(0, 5)
      .map((f) => ({
        status: readable(asRecord(f).displayStatus),
        tracking: asArray(asRecord(f).trackingInfo)
          .slice(0, 3)
          .map((t) => ({ carrier: clean(asRecord(t).company, 60), number: clean(asRecord(t).number, 60), url: cleanUrl(asRecord(t).url) })),
      }))
  }
  return order
}

async function graphql(config: ConnectorConfig, deps: ConnectorDeps, variables: Record<string, unknown>) {
  const res = await send(deps, 'Shopify', {
    url: `https://${shopDomain(config)}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    method: 'POST',
    headers: headers(config),
    body: JSON.stringify({ query: ORDERS_QUERY, variables }),
    timeoutMs: 4_000,
    maxBytes: 256 * 1024,
  })
  const body = jsonObject(expectOk(res, 'Shopify'), 'Shopify')
  const errors = asArray(body.errors)
  if (errors.length) {
    const code = clean(asRecord(asRecord(errors[0]).extensions).code, 40)
    if (code === 'THROTTLED') throw new ConnectorError('rate_limited', 'Shopify is rate-limiting requests. Try again shortly.')
    if (code === 'ACCESS_DENIED') throw new ConnectorError('forbidden', 'Shopify refused: the token needs the read_orders scope.')
    throw new ConnectorError('invalid_response', `Shopify returned an error: ${clean(asRecord(errors[0]).message, 160) ?? 'unknown'}.`)
  }
  return asArray(asRecord(asRecord(body.data).orders).nodes)
}

export const shopify: Connector = {
  id: 'shopify',
  label: 'Shopify',
  description: 'Order status, items, shipping and tracking for the visitor’s recent orders.',
  setupUrl: 'https://help.shopify.com/en/manual/apps/app-types/custom-apps',
  fields: [
    {
      name: 'shop_domain',
      label: 'Shop domain',
      secret: false,
      env: 'SHOPIFY_SHOP_DOMAIN',
      required: true,
      placeholder: 'your-store.myshopify.com',
      validate: (v) => (SHOP_DOMAIN.test(v.trim().toLowerCase()) ? null : 'Use your .myshopify.com domain, like your-store.myshopify.com.'),
    },
    {
      name: 'admin_token',
      label: 'Admin API access token',
      secret: true,
      env: 'SHOPIFY_ADMIN_TOKEN',
      required: true,
      placeholder: 'shpat_…',
      hint: 'From a custom app with only the read_orders scope.',
      validate: (v) => (/^[A-Za-z0-9_-]{20,200}$/.test(v.trim()) ? null : 'That doesn’t look like a Shopify access token.'),
    },
  ],
  options: [
    { name: 'include_items', label: 'Items in each order', default: true },
    { name: 'include_tracking', label: 'Shipping and tracking links', default: true },
  ],
  topics: () => /\b(?:orders?|ship(?:ping|ped|ment)?|track(?:ing)?|deliver(?:y|ed)?|package|parcel|arriv\w*|returns?|refunds?|purchases?|bought)\b|#\s?\d{3,}/i,

  async test(config, deps) {
    const res = await send(deps, 'Shopify', {
      url: `https://${shopDomain(config)}/admin/oauth/access_scopes.json`,
      headers: headers(config),
    })
    const body = jsonObject(expectOk(res, 'Shopify'), 'Shopify')
    const scopes = asArray(body.access_scopes).map((s) => String(asRecord(s).handle ?? ''))
    const writes = scopes.filter((s) => s.startsWith('write_'))
    if (writes.length) {
      return { ok: false, detail: `This token can change your store (${writes.join(', ')}). Create one with only read_orders, so the assistant can never change anything.` }
    }
    if (!scopes.includes('read_orders')) return { ok: false, detail: 'This token is missing the read_orders scope.' }
    return {
      ok: true,
      detail: scopes.includes('read_all_orders')
        ? 'Connected, read-only. All orders are visible.'
        : 'Connected, read-only. Shopify shows the last 60 days of orders (add read_all_orders for older ones).',
    }
  },

  cacheKey: (_config, input) => orderNumberIn(input.question) ?? '',

  async lookup(config, input, deps) {
    const number = orderNumberIn(input.question)
    // Shopify's search matches loosely, so every order is checked against
    // the verified email before it's used.
    const q = number ? `name:#${number}` : `email:"${input.email}"`
    const nodes = (await graphql(config, deps, { q, first: number ? 3 : MAX_ORDERS })).filter((n) => sameEmail(asRecord(n).email, input.email))
    if (!nodes.length) {
      return {
        status: 'not_found',
        summary: number ? `no order #${number} for this email` : 'no orders for this email',
      }
    }
    const orders = nodes.slice(0, MAX_ORDERS).map((n) => projectOrder(n, config.options))
    return { status: 'ok', summary: `${orders.length} order${orders.length === 1 ? '' : 's'}`, data: { orders } }
  },
}
