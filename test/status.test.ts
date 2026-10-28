import { test } from 'node:test'
import assert from 'node:assert/strict'
import { aiActivity, describeConnectionError, proxyWarning, recordAiAccepted, recordAiFailure } from '../src/server/status.server.ts'
import { ModelRiverError } from '../src/server/modelriver.server.ts'
import { allow, rateLimitHits, resetRateLimits } from '../src/server/rate-limit.server.ts'

test('connection problems are explained in terms an admin can act on', () => {
  assert.equal(describeConnectionError(new ModelRiverError('Unauthorized', 401)).state, 'rejected')
  assert.equal(describeConnectionError(new ModelRiverError('Forbidden', 403)).state, 'rejected')
  const server = describeConnectionError(new ModelRiverError('Bad gateway', 502))
  assert.equal(server.state, 'error')
  assert.match(server.detail, /502/)
  assert.equal(describeConnectionError(new TypeError('fetch failed')).state, 'unreachable')
  const timeout = new Error('timed out')
  timeout.name = 'TimeoutError'
  assert.equal(describeConnectionError(timeout).state, 'unreachable')
})

test('a proxy without trusted hops is flagged, a configured one is not', () => {
  assert.match(proxyWarning({ forwardedFor: true, trustedProxyHops: 0, clientIpHeader: '' })!, /TRUST_PROXY_HOPS/)
  assert.equal(proxyWarning({ forwardedFor: true, trustedProxyHops: 1, clientIpHeader: '' }), null)
  assert.equal(proxyWarning({ forwardedFor: true, trustedProxyHops: 0, clientIpHeader: 'cf-connecting-ip' }), null)
  assert.equal(proxyWarning({ forwardedFor: false, trustedProxyHops: 0, clientIpHeader: '' }), null)
})

test('AI activity remembers the last answer and the last failure', () => {
  recordAiAccepted(new Date('2026-10-25T10:00:00Z'))
  recordAiFailure('site-wide AI budget used up', new Date('2026-10-25T10:05:00Z'))
  assert.deepEqual(aiActivity(), {
    lastAnswerAt: '2026-10-25T10:00:00.000Z',
    lastFailure: { at: '2026-10-25T10:05:00.000Z', reason: 'site-wide AI budget used up' },
  })
})

test('budget usage can be read without using any of it', () => {
  resetRateLimits()
  const T = 1_800_000_000_000
  for (let i = 0; i < 3; i++) allow('ai-global-minute', 60, 60_000, T + i)
  assert.equal(rateLimitHits('ai-global-minute', 60_000, T + 10), 3)
  assert.equal(rateLimitHits('ai-global-minute', 60_000, T + 10), 3, 'reading does not count')
  assert.equal(rateLimitHits('ai-global-minute', 60_000, T + 120_000), 0, 'old hits drop out')
})
