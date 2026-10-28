import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import { customHttp, signBody } from '../src/server/connectors/custom-http.server.ts'
import { safeRequest } from '../src/server/safe-http.server.ts'
import { wordsPattern, type ConnectorConfig } from '../src/server/connectors/types.ts'
import { failsWith, fakeHttp } from './connector-helpers.ts'

const SECRET = 'a-shared-signing-secret-of-32-chars!!'
const NOW = new Date('2026-10-28T12:00:00Z')
const config = (values: Record<string, string> = {}, options: Record<string, boolean> = {}): ConnectorConfig => ({
  values: { url: 'https://api.example.com/desk/lookup', signing_secret: SECRET, name: 'Licences', ...values },
  options: { send_question: true, ...options },
  allowPrivate: false,
})
const input = { email: 'sam@example.com', question: 'how many seats do I have?', conversationId: 'c1' }
const always = (json: unknown, status = 200) => fakeHttp([[() => true, () => ({ status, json })]])

test('sends a signed request with the verified email and question', async () => {
  const http = always({ facts: [{ label: 'Plan', value: 'Team, 12 seats' }] })
  const result = await customHttp.lookup(config(), input, { ...http, now: () => NOW })
  assert.deepEqual(result, { status: 'ok', summary: '1 fact', data: { facts: [{ label: 'Plan', value: 'Team, 12 seats', url: null }] } })
  const call = http.calls[0]!
  assert.equal(call.method, 'POST')
  const body = JSON.parse(call.body!)
  assert.deepEqual(body, { type: 'lookup', email: 'sam@example.com', conversation_id: 'c1', question: 'how many seats do I have?', sent_at: NOW.toISOString() })
  const timestamp = call.headers!['X-Desk-Timestamp']!
  assert.equal(timestamp, String(NOW.getTime() / 1000))
  const expected = `sha256=${createHmac('sha256', SECRET).update(`${timestamp}.${call.body}`).digest('hex')}`
  assert.equal(call.headers!['X-Desk-Signature'], expected)
  assert.ok(!JSON.stringify(call).includes(SECRET))
})

test('the question can be kept out of the request', async () => {
  const http = always({ found: false })
  const result = await customHttp.lookup(config({}, { send_question: false }), input, http)
  assert.deepEqual(result, { status: 'not_found', summary: 'nothing found for this email' })
  assert.equal('question' in JSON.parse(http.calls[0]!.body!), false)
  assert.equal(customHttp.cacheKey!(config({}, { send_question: false }), input), '')
  assert.notEqual(customHttp.cacheKey!(config(), input), customHttp.cacheKey!(config(), { ...input, question: 'other' }))
})

test('answers are limited to 20 short facts with https links only', async () => {
  const facts = Array.from({ length: 30 }, (_, i) => ({ label: `Fact ${i}`, value: 'x'.repeat(1000), url: i === 0 ? 'javascript:alert(1)' : 'https://example.com/a' }))
  const result = await customHttp.lookup(config(), input, always({ facts: [{ label: '', value: 'no label' }, ...facts] }))
  assert.ok(result.status === 'ok')
  const out = (result.data as { facts: Array<{ label: string; value: string; url: string | null }> }).facts
  assert.equal(out.length, 19) // 20 taken, the unlabelled one dropped
  assert.ok(out.every((f) => f.value.length <= 300))
  assert.equal(out[0]!.url, null)
  assert.equal(out[1]!.url, 'https://example.com/a')
})

test('no facts means nothing found', async () => {
  assert.equal((await customHttp.lookup(config(), input, always({ facts: [] }))).status, 'not_found')
  assert.equal((await customHttp.lookup(config(), input, always({}))).status, 'not_found')
})

test('a short secret is refused before anything is sent', async () => {
  const http = always({})
  await assert.rejects(customHttp.lookup(config({ signing_secret: 'short' }), input, http), failsWith('error', /32 characters/))
  assert.equal(http.calls.length, 0)
})

test('HTTP failures are reported under the connector’s name', async () => {
  await assert.rejects(customHttp.lookup(config(), input, always({}, 401)), failsWith('rejected', /^Licences rejected/))
  await assert.rejects(customHttp.lookup(config(), input, always({}, 500)), failsWith('unreachable'))
})

test('the private-network setting is passed through', async () => {
  const http = always({ found: false })
  await customHttp.lookup({ ...config(), allowPrivate: true }, input, http)
  assert.equal(http.calls[0]!.allowPrivate, true)
})

test('admin topic words match literally', () => {
  const p = wordsPattern('seats, licence, a.b, (x)'.split(','))!
  assert.ok(p.test('How many SEATS do I have?'))
  assert.ok(p.test('my licence key'))
  assert.ok(p.test('a.b'))
  assert.ok(!p.test('aXb'))
  assert.equal(wordsPattern(['', ' ']), null)
  assert.equal(customHttp.topics(config({ topics: '' })), null)
})

// End to end over real HTTPS: a server that verifies the signature the way
// the README tells people to.
const cert = fs.readFileSync(new URL('./fixtures/localhost-cert.pem', import.meta.url))
const key = fs.readFileSync(new URL('./fixtures/localhost-key.pem', import.meta.url))
let server: https.Server
let url = ''

before(async () => {
  server = https.createServer({ cert, key }, (req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const timestamp = String(req.headers['x-desk-timestamp'] ?? '')
      const given = Buffer.from(String(req.headers['x-desk-signature'] ?? ''))
      const expected = Buffer.from(signBody(SECRET, timestamp, raw))
      const fresh = Math.abs(Date.now() / 1000 - Number(timestamp)) < 300
      if (!fresh || given.length !== expected.length || !timingSafeEqual(given, expected)) return res.writeHead(401).end()
      const body = JSON.parse(raw)
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ facts: [{ label: 'Seats', value: `12 for ${body.email}` }] }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  url = `https://localhost:${(server.address() as AddressInfo).port}/lookup`
})

after(() => {
  server.closeAllConnections()
  server.close()
})

const localRequest = (req: Parameters<typeof safeRequest>[0]) =>
  safeRequest(req, { resolve: async () => [{ address: '127.0.0.1', family: 4 }], ca: cert })

test('a real server verifying the signature accepts it, and rejects a wrong secret', async () => {
  const cfg = { ...config({ url }), allowPrivate: true }
  const result = await customHttp.lookup(cfg, input, { request: localRequest })
  assert.deepEqual(result, { status: 'ok', summary: '1 fact', data: { facts: [{ label: 'Seats', value: '12 for sam@example.com', url: null }] } })
  assert.deepEqual(await customHttp.test(cfg, { request: localRequest }), { ok: true, detail: 'Licences answered the signed test request.' })
  const wrong = { ...config({ url, signing_secret: 'another-secret-that-is-32-chars-long' }), allowPrivate: true }
  await assert.rejects(customHttp.lookup(wrong, input, { request: localRequest }), failsWith('rejected'))
})

test('without the private-network setting, a local endpoint is refused', async () => {
  await assert.rejects(customHttp.lookup(config({ url }), input, { request: localRequest }), failsWith('error', /private or reserved/))
})
