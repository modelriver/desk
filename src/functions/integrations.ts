import { createServerFn } from '@tanstack/react-start'
import { asObject, oneOf } from './validate.ts'
import { requireUser } from '../server/auth.server.ts'
import { allowAll } from '../server/rate-limit.server.ts'
import { getDb } from '../server/db.server.ts'
import { env } from '../server/env.server.ts'
import { identityMethods, VERIFIED_IDLE_MS } from '../server/identity.server.ts'
import { auditLog, CONNECTORS, connectorName, connectorView, recentEvents, saveConnector, testConnector } from '../server/integrations.server.ts'

// Admins only: connectors (Shopify, Stripe, Cal.com, Custom HTTP). Keys go in
// and never come back out; this page only ever learns whether one is set.

const IDS = CONNECTORS.map((c) => c.id)

function integrations() {
  const db = getDb()
  return {
    secretKeySet: env.secretKey !== null,
    allowPrivate: env.allowPrivateConnectorUrls,
    identity: identityMethods(),
    verification: { hours: env.verifiedHours, idleHours: VERIFIED_IDLE_MS / 3_600_000 },
    connectors: CONNECTORS.map((c) => ({ ...connectorView(db, c), name: connectorName(db, c) })),
    events: recentEvents(db, 50),
    audit: auditLog(db, 20),
  }
}

export type IntegrationsData = ReturnType<typeof integrations>

export const getIntegrations = createServerFn({ method: 'POST' }).handler(() => {
  requireUser('admin')
  return integrations()
})

function stringMap(value: unknown, max: number): Record<string, string> {
  if (value === undefined) return {}
  const o = asObject(value)
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(o)) {
    if (typeof v !== 'string') throw new Error(`${k} must be text.`)
    if (v.length > max) throw new Error(`${k} is too long.`)
    out[k] = v
  }
  return out
}

function boolMap(value: unknown): Record<string, boolean> {
  if (value === undefined) return {}
  const out: Record<string, boolean> = {}
  for (const [k, v] of Object.entries(asObject(value))) {
    if (typeof v !== 'boolean') throw new Error(`${k} must be on or off.`)
    out[k] = v
  }
  return out
}

export const saveIntegration = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const o = asObject(input)
    const clear = o.clear === undefined ? [] : o.clear
    if (!Array.isArray(clear) || !clear.every((c) => typeof c === 'string')) throw new Error('clear is invalid.')
    if (typeof o.enabled !== 'boolean') throw new Error('enabled is required.')
    return {
      id: oneOf(o, 'id', IDS),
      enabled: o.enabled,
      values: stringMap(o.values, 2000),
      clear: clear as string[],
      options: boolMap(o.options),
    }
  })
  .handler(({ data }) => {
    const me = requireUser('admin')
    if (!allowAll([{ key: `integrations-save:${me.id}`, max: 30, windowMs: 10 * 60_000 }])) {
      throw new Error('That’s a lot of changes in a short time. Try again in a few minutes.')
    }
    saveConnector(getDb(), data, me)
    return integrations()
  })

// Calls the service with the saved settings, read-only, and reports what
// it found (including keys that could change things, which are refused).
export const testIntegration = createServerFn({ method: 'POST' })
  .validator((input: unknown) => ({ id: oneOf(asObject(input), 'id', IDS) }))
  .handler(async ({ data }) => {
    const me = requireUser('admin')
    if (!allowAll([{ key: `integrations-test:${me.id}:${data.id}`, max: 5, windowMs: 10 * 60_000 }])) {
      throw new Error('That’s a few tests already. Try again in a few minutes.')
    }
    return testConnector(getDb(), data.id)
  })
