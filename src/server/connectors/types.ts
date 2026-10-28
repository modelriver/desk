import { SafeHttpError, type RequestFn, type SafeResponse } from '../safe-http.server.ts'

// A connector looks up the verified visitor's own records in one outside
// service, read-only. Connectors know nothing about Desk's database, cookies
// or settings: they get their configuration, the visitor's verified email and
// a request function, and return a small, fixed set of fields. That keeps
// them easy to test, and easy to reuse elsewhere.

export interface FieldSpec {
  name: string
  label: string
  // Secret fields are stored encrypted and never shown again.
  secret: boolean
  // Environment variable that sets it instead (and wins over the dashboard).
  env: string
  required: boolean
  placeholder?: string
  hint?: string
  // Returns a problem with the value, or null when it's fine.
  validate?: (value: string) => string | null
}

export interface OptionSpec {
  name: string
  label: string
  hint?: string
  default: boolean
}

export interface ConnectorConfig {
  values: Record<string, string>
  options: Record<string, boolean>
  // Whether private network addresses may be reached (DESK_ALLOW_PRIVATE_CONNECTOR_URLS).
  allowPrivate: boolean
}

export interface ConnectorDeps {
  request: RequestFn
  now?: () => Date
}

export interface LookupInput {
  // Verified, lowercased.
  email: string
  question: string
  conversationId: string
}

export type Snapshot =
  | { status: 'ok'; summary: string; data: unknown }
  | { status: 'not_found'; summary: string }

export interface TestResult {
  ok: boolean
  detail: string
}

export interface Connector {
  id: string
  label: string
  description: string
  // Where to create the key, for the Integrations page.
  setupUrl: string
  fields: FieldSpec[]
  options: OptionSpec[]
  // What the visitor and the AI call it, when it isn't `label` (Custom HTTP's admin-chosen name).
  displayName?: (config: ConnectorConfig) => string
  // Words that make a question about this service. null: every question.
  topics: (config: ConnectorConfig) => RegExp | null
  test: (config: ConnectorConfig, deps: ConnectorDeps) => Promise<TestResult>
  lookup: (config: ConnectorConfig, input: LookupInput, deps: ConnectorDeps) => Promise<Snapshot>
  // What in the question changes the answer (an order number, say), so a
  // cached lookup is only reused for the same thing. Default: nothing.
  cacheKey?: (config: ConnectorConfig, input: LookupInput) => string
}

export type ConnectorFailure = 'rejected' | 'forbidden' | 'not_found' | 'rate_limited' | 'unreachable' | 'invalid_response' | 'error'

export class ConnectorError extends Error {
  kind: ConnectorFailure
  constructor(kind: ConnectorFailure, message: string) {
    super(message)
    this.kind = kind
  }
}

// Turns an HTTP status from `service` into a ConnectorError, or returns the
// response when it's a success.
export function expectOk(res: SafeResponse, service: string): SafeResponse {
  if (res.status >= 200 && res.status < 300) return res
  if (res.status === 401) throw new ConnectorError('rejected', `${service} rejected the key (401). Check it, or create a new one.`)
  if (res.status === 403) throw new ConnectorError('forbidden', `${service} refused (403): the key is missing a read permission.`)
  if (res.status === 404) throw new ConnectorError('not_found', `${service} answered 404. Check the address.`)
  if (res.status === 429) throw new ConnectorError('rate_limited', `${service} is rate-limiting requests (429). Try again shortly.`)
  if (res.status >= 500) throw new ConnectorError('unreachable', `${service} had a problem (${res.status}). Try again shortly.`)
  throw new ConnectorError('error', `${service} answered ${res.status}.`)
}

export function jsonObject(res: SafeResponse, service: string): Record<string, unknown> {
  if (!res.json || typeof res.json !== 'object' || Array.isArray(res.json)) {
    throw new ConnectorError('invalid_response', `${service} didn’t send the JSON we expected.`)
  }
  return res.json as Record<string, unknown>
}

// Runs a request and maps network problems (timeouts, blocked addresses) to
// ConnectorErrors too, so callers handle one error type.
export async function send(deps: ConnectorDeps, service: string, req: Parameters<RequestFn>[0]): Promise<SafeResponse> {
  try {
    return await deps.request(req)
  } catch (err) {
    if (err instanceof SafeHttpError) {
      throw new ConnectorError(err.kind === 'invalid_url' || err.kind === 'blocked' ? 'error' : 'unreachable', err.message)
    }
    throw new ConnectorError('unreachable', `Couldn’t reach ${service}.`)
  }
}

// Text from an outside service, made safe to show the AI: a string, trimmed
// to `max` characters, without the [[...]] markers the widget acts on.
export function clean(value: unknown, max = 200): string | null {
  if (value === null || value === undefined) return null
  const text = (typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : '')
    .replace(/\[\[|\]\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return null
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

// An https link from an outside service, or null. Other schemes
// (javascript:, data:) never reach the AI or the visitor.
export function cleanUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2000) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

export function sameEmail(a: unknown, b: string): boolean {
  return typeof a === 'string' && a.trim().toLowerCase() === b
}

// Words for a topic regex, from admin text ("plan, licence, seats"). Escaped,
// so they match literally.
export function wordsPattern(words: string[]): RegExp | null {
  const parts = words.map((w) => w.trim().toLowerCase()).filter((w) => w.length >= 2 && w.length <= 40)
  if (!parts.length) return null
  return new RegExp(`\\b(?:${parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'i')
}
