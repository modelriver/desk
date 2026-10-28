import assert from 'node:assert/strict'
import type { SafeRequest, SafeResponse } from '../src/server/safe-http.server.ts'
import { ConnectorError, type ConnectorFailure } from '../src/server/connectors/types.ts'

// A stand-in for the network: answers requests from a list of routes and
// records what was sent. No real HTTP.

type Route = [match: (req: SafeRequest, url: URL) => boolean, reply: (req: SafeRequest, url: URL) => { status?: number; json?: unknown; text?: string }]

export function fakeHttp(routes: Route[]) {
  const calls: Array<SafeRequest & { parsed: URL }> = []
  const request = async (req: SafeRequest): Promise<SafeResponse> => {
    const url = new URL(req.url)
    calls.push({ ...req, parsed: url })
    const route = routes.find(([match]) => match(req, url))
    if (!route) return { status: 404, text: '', json: undefined }
    const r = route[1](req, url)
    const text = r.text ?? (r.json === undefined ? '' : JSON.stringify(r.json))
    return { status: r.status ?? 200, text, json: r.json }
  }
  return { request, calls }
}

export const path = (p: string) => (_req: SafeRequest, url: URL) => url.pathname === p

export function failsWith(kind: ConnectorFailure, message?: RegExp) {
  return (err: unknown) => {
    assert.ok(err instanceof ConnectorError, String(err))
    assert.equal((err as ConnectorError).kind, kind, (err as Error).message)
    if (message) assert.match((err as Error).message, message)
    return true
  }
}

// Fails if any of these strings appear anywhere in the value.
export function assertAbsent(value: unknown, needles: string[]) {
  const text = JSON.stringify(value)
  for (const n of needles) assert.ok(!text.includes(n), `found ${JSON.stringify(n)} in ${text}`)
}
