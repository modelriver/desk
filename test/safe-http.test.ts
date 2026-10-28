import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import { isBlockedAddress, parseHttpsUrl, safeRequest, SafeHttpError, type Resolver } from '../src/server/safe-http.server.ts'

const cert = fs.readFileSync(new URL('./fixtures/localhost-cert.pem', import.meta.url))
const key = fs.readFileSync(new URL('./fixtures/localhost-key.pem', import.meta.url))

let server: https.Server
let base = ''

before(async () => {
  server = https.createServer({ cert, key }, (req, res) => {
    if (req.url === '/json') return res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
    if (req.url === '/text') return res.writeHead(200).end('not json')
    if (req.url === '/redirect') return res.writeHead(302, { location: 'https://169.254.169.254/' }).end()
    if (req.url === '/big') return res.writeHead(200).end('x'.repeat(200_000))
    if (req.url === '/slow') {
      // Cleared when the client gives up, so the server can close promptly.
      const timer = setTimeout(() => res.writeHead(200).end('{}'), 2_000)
      res.on('close', () => clearTimeout(timer))
      return
    }
    if (req.url === '/echo') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ method: req.method, body, sig: req.headers['x-test'] })))
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `https://localhost:${(server.address() as AddressInfo).port}`
})

after(() => {
  server.closeAllConnections()
  server.close()
})

// "localhost" resolves to the test server's address without touching DNS.
const toLoopback: Resolver = async () => [{ address: '127.0.0.1', family: 4 }]

function kind(expected: SafeHttpError['kind']) {
  return (err: unknown) => {
    assert.ok(err instanceof SafeHttpError, String(err))
    assert.equal((err as SafeHttpError).kind, expected, (err as Error).message)
    return true
  }
}

test('private, loopback, link-local and reserved addresses are blocked', () => {
  for (const ip of [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '::ffff:a9fe:a9fe',
    '64:ff9b::a9fe:a9fe',
    '2002:7f00:1::1',
    'not-an-ip',
  ]) {
    assert.equal(isBlockedAddress(ip), true, ip)
  }
})

test('public addresses are allowed', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '23.227.38.65', '2606:4700:4700::1111', '2a00:1450:4001:80b::200e']) {
    assert.equal(isBlockedAddress(ip), false, ip)
  }
})

test('only plain https URLs are accepted', () => {
  assert.throws(() => parseHttpsUrl('http://example.com'), kind('invalid_url'))
  assert.throws(() => parseHttpsUrl('ftp://example.com'), kind('invalid_url'))
  assert.throws(() => parseHttpsUrl('https://user:pass@example.com'), kind('invalid_url'))
  assert.throws(() => parseHttpsUrl('not a url'), kind('invalid_url'))
  assert.throws(() => parseHttpsUrl(`https://example.com/${'a'.repeat(2100)}`), kind('invalid_url'))
  assert.equal(parseHttpsUrl('https://example.com/a?b=1').hostname, 'example.com')
})

test('a literal private IP is refused before any connection', async () => {
  await assert.rejects(safeRequest({ url: 'https://169.254.169.254/latest/meta-data' }), kind('blocked'))
  await assert.rejects(safeRequest({ url: 'https://[::1]/' }), kind('blocked'))
  await assert.rejects(safeRequest({ url: 'https://127.0.0.1/' }), kind('blocked'))
})

test('a hostname that resolves to a private address is refused at connect time (DNS rebinding)', async () => {
  let asked = 0
  const rebinding: Resolver = async () => {
    asked++
    return [{ address: '10.0.0.7', family: 4 }]
  }
  await assert.rejects(safeRequest({ url: 'https://looks-public.example/' }, { resolve: rebinding }), kind('blocked'))
  assert.equal(asked, 1)
  // Any private address among several is enough to refuse.
  const mixed: Resolver = async () => [
    { address: '93.184.216.34', family: 4 },
    { address: '127.0.0.1', family: 4 },
  ]
  await assert.rejects(safeRequest({ url: 'https://mixed.example/' }, { resolve: mixed }), kind('blocked'))
})

test('http is refused even with private addresses allowed', async () => {
  await assert.rejects(safeRequest({ url: `${base.replace('https', 'http')}/json`, allowPrivate: true }), kind('invalid_url'))
})

test('with private addresses allowed, a local HTTPS server answers', async () => {
  const res = await safeRequest({ url: `${base}/json`, allowPrivate: true }, { resolve: toLoopback, ca: cert })
  assert.equal(res.status, 200)
  assert.deepEqual(res.json, { ok: true })
})

test('without allowPrivate, the same local server is refused', async () => {
  await assert.rejects(safeRequest({ url: `${base}/json` }, { resolve: toLoopback, ca: cert }), kind('blocked'))
})

test('a body that isn’t JSON comes back as text with json undefined', async () => {
  const res = await safeRequest({ url: `${base}/text`, allowPrivate: true }, { resolve: toLoopback, ca: cert })
  assert.equal(res.text, 'not json')
  assert.equal(res.json, undefined)
})

test('redirects are never followed', async () => {
  await assert.rejects(safeRequest({ url: `${base}/redirect`, allowPrivate: true }, { resolve: toLoopback, ca: cert }), kind('redirect'))
})

test('responses over the size cap are cut off', async () => {
  await assert.rejects(
    safeRequest({ url: `${base}/big`, allowPrivate: true, maxBytes: 64 * 1024 }, { resolve: toLoopback, ca: cert }),
    kind('too_large'),
  )
})

test('slow servers time out', async () => {
  await assert.rejects(safeRequest({ url: `${base}/slow`, allowPrivate: true, timeoutMs: 200 }, { resolve: toLoopback, ca: cert }), kind('timeout'))
})

test('an untrusted certificate fails as a network error', async () => {
  await assert.rejects(safeRequest({ url: `${base}/json`, allowPrivate: true }, { resolve: toLoopback }), kind('network'))
})

test('POST sends the body and headers', async () => {
  const res = await safeRequest(
    { url: `${base}/echo`, method: 'POST', body: '{"a":1}', headers: { 'x-test': 'yes' }, allowPrivate: true },
    { resolve: toLoopback, ca: cert },
  )
  assert.deepEqual(res.json, { method: 'POST', body: '{"a":1}', sig: 'yes' })
})
