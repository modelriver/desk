import fs from 'node:fs'
import path from 'node:path'
import { env } from './env.server.ts'
import * as mr from './modelriver.server.ts'
import { errorMessage } from '../lib/errors.ts'

// Health of the AI connection, for the admin Settings page.

// --- AI activity since the server started (kept in memory) ---

let lastAnswerAt: string | null = null
let lastFailure: { at: string; reason: string } | null = null

// ModelRiver accepted a question and started answering.
export function recordAiAccepted(at = new Date()) {
  lastAnswerAt = at.toISOString()
}

// The AI couldn't answer, and the chat went to the team.
export function recordAiFailure(reason: string, at = new Date()) {
  lastFailure = { at: at.toISOString(), reason: reason.slice(0, 200) }
}

export function aiActivity() {
  return { lastAnswerAt, lastFailure }
}

// --- Is ModelRiver reachable with this key? ---

export type ConnectionState = 'connected' | 'no_key' | 'rejected' | 'unreachable' | 'error'

export interface ConnectionCheck {
  state: ConnectionState
  detail: string
  checkedAt: string
  latencyMs: number | null
}

// Turns a failed check into something an admin can act on.
export function describeConnectionError(err: unknown): { state: ConnectionState; detail: string } {
  if (err instanceof mr.ModelRiverError) {
    if (err.status === 401 || err.status === 403) {
      return { state: 'rejected', detail: 'ModelRiver rejected the API key. Check MODELRIVER_API_KEY, or create a new key in the console.' }
    }
    return { state: 'error', detail: `ModelRiver answered with an error (${err.status}): ${err.message}` }
  }
  const name = err instanceof Error ? err.name : ''
  if (name === 'TimeoutError' || name === 'AbortError') {
    return { state: 'unreachable', detail: `ModelRiver didn’t respond in time at ${env.modelriverApiUrl}.` }
  }
  if (err instanceof TypeError) {
    return { state: 'unreachable', detail: `Couldn’t reach ${env.modelriverApiUrl}. Check MODELRIVER_API_URL and the server’s network.` }
  }
  return { state: 'error', detail: errorMessage(err, 'The check failed.') }
}

const CACHE_MS = 30_000
let cached: ConnectionCheck | null = null

// Lists one session with the key: proves the key works and the API answers,
// without calling a model. Cached for 30 seconds unless `force`.
export async function checkModelRiver({ force = false } = {}): Promise<ConnectionCheck> {
  if (!force && cached && Date.now() - Date.parse(cached.checkedAt) < CACHE_MS) return cached
  const checkedAt = new Date().toISOString()
  if (!env.modelriverApiKey) {
    cached = { state: 'no_key', detail: 'MODELRIVER_API_KEY isn’t set, so the AI can’t answer. Add it to the server’s environment and restart.', checkedAt, latencyMs: null }
    return cached
  }
  const started = performance.now()
  try {
    await mr.listSessions(1, 1)
    cached = { state: 'connected', detail: 'The API key works and ModelRiver is answering.', checkedAt, latencyMs: Math.round(performance.now() - started) }
  } catch (err) {
    cached = { ...describeConnectionError(err), checkedAt, latencyMs: null }
  }
  return cached
}

// --- Small facts about the install ---

let version: string | undefined
export function appVersion(): string {
  if (version === undefined) {
    try {
      version = String(JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')).version ?? 'unknown')
    } catch {
      version = 'unknown'
    }
  }
  return version
}

// Whether the client-IP settings look wrong for how requests are arriving.
// Behind a proxy with no trusted hops, every visitor looks like the proxy,
// so they'd all share one set of rate limits.
export function proxyWarning(input: { forwardedFor: boolean; trustedProxyHops: number; clientIpHeader: string }): string | null {
  if (input.forwardedFor && input.trustedProxyHops === 0 && !input.clientIpHeader) {
    return 'Requests arrive through a proxy, but TRUST_PROXY_HOPS is 0 and CLIENT_IP_HEADER isn’t set, so every visitor looks like the proxy and shares one set of rate limits. Set TRUST_PROXY_HOPS (or CLIENT_IP_HEADER) to match your setup.'
  }
  return null
}
