import type { DatabaseSync } from 'node:sqlite'
import { now } from './db.server.ts'
import { env } from './env.server.ts'
import { deleteSecret, readSecret, saveSecret, scrub, secretState, SecretError, type SecretState } from './secrets.server.ts'
import { requestFn, type RequestFn } from './safe-http.server.ts'
import { allowAll } from './rate-limit.server.ts'
import { TtlCache } from './ttl-cache.server.ts'
import { shopify } from './connectors/shopify.server.ts'
import { stripe } from './connectors/stripe.server.ts'
import { calcom } from './connectors/calcom.server.ts'
import { customHttp } from './connectors/custom-http.server.ts'
import { ConnectorError, type Connector, type ConnectorConfig, type Snapshot, type TestResult } from './connectors/types.ts'

// Desk's side of connectors: where their settings and keys live, which ones
// a question needs, rate limits, caching, and the record of every lookup.

export const CONNECTORS: readonly Connector[] = [shopify, stripe, calcom, customHttp]

export function connectorById(id: string): Connector | undefined {
  return CONNECTORS.find((c) => c.id === id)
}

// The name visitors, the AI and the team see: Custom HTTP's is chosen by the admin.
export function connectorName(db: DatabaseSync, c: Connector, e: IntegrationsEnv = processEnv()): string {
  return c.displayName?.(loadConfig(db, c, e).config) ?? c.label
}

// Where settings come from, so tests can pass their own.
export interface IntegrationsEnv {
  secretKey: Buffer | null
  allowPrivate: boolean
  vars: Record<string, string | undefined>
}

export function processEnv(): IntegrationsEnv {
  return { secretKey: env.secretKey, allowPrivate: env.allowPrivateConnectorUrls, vars: process.env }
}

interface StoredSettings {
  values: Record<string, string>
  options: Record<string, boolean>
}

function readStored(db: DatabaseSync, id: string): { enabled: boolean; settings: StoredSettings } {
  const row = db.prepare('SELECT enabled, settings FROM connector_settings WHERE connector = ?').get(id) as
    | { enabled: number; settings: string }
    | undefined
  if (!row) return { enabled: false, settings: { values: {}, options: {} } }
  let parsed: Partial<StoredSettings> = {}
  try {
    parsed = JSON.parse(row.settings) as Partial<StoredSettings>
  } catch {
    // A hand-edited row that isn't JSON: treat as empty rather than failing every chat.
  }
  return { enabled: row.enabled === 1, settings: { values: { ...parsed.values }, options: { ...parsed.options } } }
}

function envValue(e: IntegrationsEnv, name: string): string | undefined {
  const v = e.vars[name]?.trim()
  return v ? v : undefined
}

export interface LoadedConfig {
  enabled: boolean
  config: ConnectorConfig
  // Required fields with no value, by label.
  missing: string[]
  // Saved values that can't be used (say, encrypted with another DESK_SECRET_KEY).
  problems: string[]
}

export function loadConfig(db: DatabaseSync, c: Connector, e: IntegrationsEnv = processEnv()): LoadedConfig {
  const stored = readStored(db, c.id)
  const values: Record<string, string> = {}
  const missing: string[] = []
  const problems: string[] = []
  for (const f of c.fields) {
    let value: string | null = null
    if (f.secret) {
      try {
        value = readSecret(db, e.secretKey, { connector: c.id, field: f.name, envValue: envValue(e, f.env) })
      } catch (err) {
        if (!(err instanceof SecretError)) throw err
        problems.push(err.message)
      }
    } else {
      value = envValue(e, f.env) ?? stored.settings.values[f.name] ?? null
    }
    if (value) values[f.name] = value
    else if (f.required) missing.push(f.label)
  }
  const options: Record<string, boolean> = {}
  for (const o of c.options) options[o.name] = typeof stored.settings.options[o.name] === 'boolean' ? stored.settings.options[o.name]! : o.default
  return { enabled: stored.enabled, config: { values, options, allowPrivate: e.allowPrivate }, missing, problems }
}

function isReady(loaded: LoadedConfig): boolean {
  return loaded.missing.length === 0 && loaded.problems.length === 0
}

// --- For the Integrations page: everything except secret values ---

export type FieldView =
  | { name: string; label: string; secret: true; env: string; required: boolean; placeholder?: string; hint?: string; state: SecretState }
  | {
      name: string
      label: string
      secret: false
      env: string
      required: boolean
      placeholder?: string
      hint?: string
      value: string
      fromEnv: boolean
    }

export function connectorView(db: DatabaseSync, c: Connector, e: IntegrationsEnv = processEnv()) {
  const loaded = loadConfig(db, c, e)
  const stored = readStored(db, c.id)
  const fields: FieldView[] = c.fields.map((f) => {
    const base = { name: f.name, label: f.label, env: f.env, required: f.required, placeholder: f.placeholder, hint: f.hint }
    if (f.secret) {
      return { ...base, secret: true as const, state: secretState(db, e.secretKey, { connector: c.id, field: f.name, envValue: envValue(e, f.env) }) }
    }
    const fromEnv = envValue(e, f.env)
    return { ...base, secret: false as const, value: fromEnv ?? stored.settings.values[f.name] ?? '', fromEnv: fromEnv !== undefined }
  })
  return {
    id: c.id,
    label: c.label,
    description: c.description,
    setupUrl: c.setupUrl,
    enabled: loaded.enabled,
    ready: isReady(loaded),
    missing: loaded.missing,
    problems: loaded.problems,
    fields,
    options: c.options.map((o) => ({ name: o.name, label: o.label, hint: o.hint, value: loaded.config.options[o.name] ?? o.default })),
  }
}

export interface SaveInput {
  id: string
  enabled: boolean
  // New values; an empty one leaves that field as it is.
  values: Record<string, string>
  // Fields to empty.
  clear: string[]
  options: Record<string, boolean>
}

export function saveConnector(db: DatabaseSync, input: SaveInput, user: { id: string; name: string }, e: IntegrationsEnv = processEnv()) {
  const c = connectorById(input.id)
  if (!c) throw new Error('Unknown connector.')
  const fieldFor = (name: string) => {
    const f = c.fields.find((x) => x.name === name)
    if (!f) throw new Error('Unknown field.')
    return f
  }
  // Check everything before changing anything.
  const updates: Array<{ field: (typeof c.fields)[number]; value: string }> = []
  for (const [name, raw] of Object.entries(input.values)) {
    const field = fieldFor(name)
    const value = raw.trim()
    // Set in the environment, which wins: nothing to save.
    if (!value || envValue(e, field.env)) continue
    const problem = field.validate?.(value)
    if (problem) throw new Error(`${field.label}: ${problem}`)
    if (field.secret && !e.secretKey) {
      throw new Error('Set DESK_SECRET_KEY on the server to save keys here (openssl rand -base64 32), or set them in the environment.')
    }
    updates.push({ field, value })
  }
  const clears = input.clear.map(fieldFor)
  for (const name of Object.keys(input.options)) {
    if (!c.options.some((o) => o.name === name)) throw new Error('Unknown option.')
  }

  const before = readStored(db, c.id)
  const settings = before.settings
  db.exec('BEGIN')
  try {
    for (const { field, value } of updates) {
      if (field.secret) saveSecret(db, e.secretKey!, { connector: c.id, field: field.name, value, userId: user.id })
      else settings.values[field.name] = value
      audit(db, user, field.secret ? 'connector.key_saved' : 'connector.setting_saved', `${c.id}.${field.name}`)
    }
    for (const field of clears) {
      if (field.secret) deleteSecret(db, c.id, field.name)
      else delete settings.values[field.name]
      audit(db, user, 'connector.field_cleared', `${c.id}.${field.name}`)
    }
    for (const [name, value] of Object.entries(input.options)) settings.options[name] = value === true
    db.prepare(
      `INSERT INTO connector_settings (connector, enabled, settings, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (connector) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    ).run(c.id, before.enabled ? 1 : 0, JSON.stringify(settings), now(), user.id)

    if (input.enabled !== before.enabled) {
      if (input.enabled) {
        const loaded = loadConfig(db, c, e)
        if (loaded.problems.length) throw new Error(loaded.problems[0])
        if (loaded.missing.length) throw new Error(`Add ${loaded.missing.join(' and ')} before turning ${c.label} on.`)
      }
      db.prepare('UPDATE connector_settings SET enabled = ? WHERE connector = ?').run(input.enabled ? 1 : 0, c.id)
      audit(db, user, input.enabled ? 'connector.enabled' : 'connector.disabled', c.id)
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  forgetCachedLookups()
}

function secretValues(c: Connector, config: ConnectorConfig): string[] {
  return c.fields.filter((f) => f.secret).map((f) => config.values[f.name] ?? '')
}

export async function testConnector(
  db: DatabaseSync,
  id: string,
  deps: { request?: RequestFn } = {},
  e: IntegrationsEnv = processEnv(),
): Promise<TestResult> {
  const c = connectorById(id)
  if (!c) throw new Error('Unknown connector.')
  const loaded = loadConfig(db, c, e)
  if (loaded.problems.length) return { ok: false, detail: loaded.problems[0]! }
  if (loaded.missing.length) return { ok: false, detail: `Add ${loaded.missing.join(' and ')} first.` }
  try {
    const result = await c.test(loaded.config, { request: deps.request ?? requestFn() })
    return { ok: result.ok, detail: scrub(result.detail, secretValues(c, loaded.config)) }
  } catch (err) {
    if (err instanceof ConnectorError) return { ok: false, detail: scrub(err.message, secretValues(c, loaded.config)) }
    console.error(`[integrations] the ${c.label} test failed`, err)
    return { ok: false, detail: 'The test failed unexpectedly. See the server log.' }
  }
}

// --- Lookups during a chat ---

// Connectors that are on, fully set up, and either about this question or
// already used in this conversation (follow-up questions rarely repeat the
// keyword: "and when will it arrive?").
export function relevantConnectors(
  db: DatabaseSync,
  input: { text: string; conversationId: string },
  e: IntegrationsEnv = processEnv(),
): Connector[] {
  const used = new Set(
    (
      db
        .prepare("SELECT DISTINCT connector FROM connector_events WHERE conversation_id = ? AND status IN ('ok', 'not_found')")
        .all(input.conversationId) as Array<{ connector: string }>
    ).map((r) => r.connector),
  )
  return CONNECTORS.filter((c) => {
    const loaded = loadConfig(db, c, e)
    if (!loaded.enabled || !isReady(loaded)) return false
    const topics = c.topics(loaded.config)
    return topics === null || topics.test(input.text) || used.has(c.id)
  })
}

// Whether any connector is on and ready, and the words that trigger them,
// so the widget can say "Checking your account…" at the right moments.
export function lookupHints(db: DatabaseSync, e: IntegrationsEnv = processEnv()): { enabled: boolean; always: boolean; patterns: string[] } {
  const ready = CONNECTORS.map((c) => ({ c, loaded: loadConfig(db, c, e) })).filter(({ loaded }) => loaded.enabled && isReady(loaded))
  const topics = ready.map(({ c, loaded }) => c.topics(loaded.config))
  return {
    enabled: ready.length > 0,
    always: topics.some((t) => t === null),
    patterns: topics.filter((t): t is RegExp => t !== null).map((t) => t.source),
  }
}

export type LookupStatus = 'ok' | 'not_found' | 'unavailable' | 'rate_limited'

export interface LookupResult {
  connector: string
  label: string
  status: LookupStatus
  summary: string
  data?: unknown
}

const MINUTE = 60_000
const CACHE_MS = 2 * MINUTE
const EVENT_RETENTION_DAYS = 30
const cache = new TtlCache<Snapshot>(CACHE_MS)

export function forgetCachedLookups() {
  cache.clear()
}

export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@')
  if (at < 1) return '***'
  return `${email[0]}***${email.slice(at)}`
}

function recordEvent(
  db: DatabaseSync,
  input: { conversationId: string; connector: string; email: string; status: 'ok' | 'not_found' | 'error' | 'rate_limited'; detail: string; latencyMs: number | null },
) {
  db.prepare(
    `INSERT INTO connector_events (conversation_id, connector, subject_masked, status, detail, latency_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(input.conversationId, input.connector, maskEmail(input.email), input.status, input.detail.slice(0, 300), input.latencyMs, now())
}

export async function runLookups(
  db: DatabaseSync,
  input: { conversationId: string; email: string; question: string; ip: string; connectors: Connector[] },
  deps: { request?: RequestFn; now?: () => Date } = {},
  e: IntegrationsEnv = processEnv(),
): Promise<LookupResult[]> {
  if (!input.connectors.length) return []
  db.prepare('DELETE FROM connector_events WHERE created_at < ?').run(new Date(Date.now() - EVENT_RETENTION_DAYS * 86_400_000).toISOString())
  const lookupInput = { email: input.email, question: input.question, conversationId: input.conversationId }

  // Per conversation and per IP: a chat can't be used to hammer the
  // business's APIs, or to page through them.
  const allowed = allowAll([
    { key: `lookup:${input.conversationId}`, max: 10, windowMs: 10 * MINUTE },
    { key: `lookup-ip:${input.ip}`, max: 30, windowMs: 10 * MINUTE },
  ])
  if (!allowed) {
    return input.connectors.map((c) => {
      recordEvent(db, { conversationId: input.conversationId, connector: c.id, email: input.email, status: 'rate_limited', detail: 'too many lookups from this chat', latencyMs: null })
      return { connector: c.id, label: connectorName(db, c, e), status: 'rate_limited' as const, summary: 'paused for a few minutes' }
    })
  }

  const request = deps.request ?? requestFn()
  return Promise.all(
    input.connectors.map(async (c): Promise<LookupResult> => {
      const base = { connector: c.id, label: connectorName(db, c, e) }
      if (!allowAll([{ key: `lookup-global:${c.id}`, max: 120, windowMs: MINUTE }])) {
        recordEvent(db, { conversationId: input.conversationId, connector: c.id, email: input.email, status: 'rate_limited', detail: 'site-wide limit', latencyMs: null })
        return { ...base, status: 'rate_limited', summary: 'paused for a moment' }
      }
      const loaded = loadConfig(db, c, e)
      const started = performance.now()
      try {
        const key = `${input.conversationId}:${c.id}:${input.email}:${c.cacheKey?.(loaded.config, lookupInput) ?? ''}`
        const snapshot = await cache.get(key, () => c.lookup(loaded.config, lookupInput, { request, now: deps.now }))
        const latencyMs = Math.round(performance.now() - started)
        recordEvent(db, { conversationId: input.conversationId, connector: c.id, email: input.email, status: snapshot.status, detail: snapshot.summary, latencyMs })
        return snapshot.status === 'ok'
          ? { ...base, status: 'ok', summary: snapshot.summary, data: snapshot.data }
          : { ...base, status: 'not_found', summary: snapshot.summary }
      } catch (err) {
        const latencyMs = Math.round(performance.now() - started)
        const detail =
          err instanceof ConnectorError ? scrub(err.message, secretValues(c, loaded.config)) : 'unexpected error (see the server log)'
        if (!(err instanceof ConnectorError)) console.error(`[integrations] ${c.label} lookup failed`, err)
        recordEvent(db, { conversationId: input.conversationId, connector: c.id, email: input.email, status: 'error', detail, latencyMs })
        return { ...base, status: 'unavailable', summary: 'unavailable right now' }
      }
    }),
  )
}

// --- Records ---

export function audit(db: DatabaseSync, user: { id: string; name: string }, action: string, target: string) {
  db.prepare('INSERT INTO admin_audit (user_id, user_name, action, target, created_at) VALUES (?, ?, ?, ?, ?)').run(
    user.id,
    user.name,
    action,
    target,
    now(),
  )
}

export interface ConnectorEvent {
  connector: string
  subject: string
  status: string
  detail: string
  latencyMs: number | null
  createdAt: string
}

function eventRows(rows: unknown[]): ConnectorEvent[] {
  return (rows as Array<{ connector: string; subject_masked: string; status: string; detail: string; latency_ms: number | null; created_at: string }>).map(
    (r) => ({ connector: r.connector, subject: r.subject_masked, status: r.status, detail: r.detail, latencyMs: r.latency_ms, createdAt: r.created_at }),
  )
}

export function recentEvents(db: DatabaseSync, limit = 50): ConnectorEvent[] {
  return eventRows(db.prepare('SELECT * FROM connector_events ORDER BY id DESC LIMIT ?').all(limit))
}

export function conversationEvents(db: DatabaseSync, conversationId: string, limit = 20): ConnectorEvent[] {
  return eventRows(db.prepare('SELECT * FROM connector_events WHERE conversation_id = ? ORDER BY id DESC LIMIT ?').all(conversationId, limit))
}

export function auditLog(db: DatabaseSync, limit = 20) {
  return (
    db.prepare('SELECT user_name, action, target, created_at FROM admin_audit ORDER BY id DESC LIMIT ?').all(limit) as Array<{
      user_name: string
      action: string
      target: string
      created_at: string
    }>
  ).map((r) => ({ user: r.user_name, action: r.action, target: r.target, createdAt: r.created_at }))
}
