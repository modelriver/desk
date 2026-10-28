import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { pickClientIp } from '../src/server/client-ip.server.ts'
import { allow, allowAll, rateLimitKeyCount, resetRateLimits } from '../src/server/rate-limit.server.ts'
import { TtlCache } from '../src/server/ttl-cache.server.ts'

const headers = (h: Record<string, string>) => new Headers(h)
const none = { trustedHops: 0, clientIpHeader: '' }

test('X-Forwarded-For is ignored unless proxies are trusted', () => {
  assert.equal(pickClientIp(headers({ 'x-forwarded-for': '6.6.6.6' }), '10.0.0.5', none), '10.0.0.5')
  assert.equal(pickClientIp(headers({}), undefined, none), 'unknown')
})

test('a spoofed first X-Forwarded-For entry is never used', () => {
  // The client sent "6.6.6.6"; nginx appended the real address it saw.
  const h = headers({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9' })
  assert.equal(pickClientIp(h, '127.0.0.1', { trustedHops: 1, clientIpHeader: '' }), '203.0.113.9')
  // Two trusted hops (CDN then nginx): the entry the CDN appended.
  const two = headers({ 'x-forwarded-for': '6.6.6.6, 198.51.100.7, 172.70.1.1' })
  assert.equal(pickClientIp(two, '127.0.0.1', { trustedHops: 2, clientIpHeader: '' }), '198.51.100.7')
})

test('falls back to the socket when the trusted entry is missing or not an IP', () => {
  const cfg = { trustedHops: 2, clientIpHeader: '' }
  assert.equal(pickClientIp(headers({ 'x-forwarded-for': '203.0.113.9' }), '10.0.0.5', cfg), '10.0.0.5')
  const junk = headers({ 'x-forwarded-for': 'not-an-ip, 203.0.113.9' })
  assert.equal(pickClientIp(junk, '10.0.0.5', cfg), '10.0.0.5')
})

test('a configured client IP header wins when it holds a valid IP', () => {
  const cfg = { trustedHops: 1, clientIpHeader: 'cf-connecting-ip' }
  assert.equal(pickClientIp(headers({ 'cf-connecting-ip': '198.51.100.7' }), '10.0.0.5', cfg), '198.51.100.7')
  const bad = headers({ 'cf-connecting-ip': 'evil', 'x-forwarded-for': '203.0.113.9' })
  assert.equal(pickClientIp(bad, '10.0.0.5', cfg), '203.0.113.9')
})

test('IPv6 clients are grouped by /64 and IPv4-mapped addresses unwrapped', () => {
  const cfg = { trustedHops: 1, clientIpHeader: '' }
  const a = pickClientIp(headers({ 'x-forwarded-for': '2001:db8:1:2:aaaa::1' }), undefined, cfg)
  const b = pickClientIp(headers({ 'x-forwarded-for': '2001:db8:1:2:bbbb:cccc:dddd:eeee' }), undefined, cfg)
  assert.equal(a, '2001:db8:1:2::/64')
  assert.equal(a, b)
  assert.equal(pickClientIp(headers({}), '::ffff:203.0.113.9', none), '203.0.113.9')
})

beforeEach(() => resetRateLimits())

test('allow permits up to max hits per sliding window', () => {
  const t = 1_000_000
  for (let i = 0; i < 3; i++) assert.equal(allow('k', 3, 1000, t + i), true)
  assert.equal(allow('k', 3, 1000, t + 10), false)
  assert.equal(allow('k', 3, 1000, t + 1001), true, 'oldest hit has left the window')
})

test('allowAll records nothing when any limit is full', () => {
  const t = 2_000_000
  assert.equal(allowAll([{ key: 'ip', max: 1, windowMs: 1000 }], t), true)
  // The per-IP limit is full, so the global budget must not be spent.
  for (let i = 0; i < 5; i++) {
    assert.equal(allowAll([{ key: 'ip', max: 1, windowMs: 1000 }, { key: 'global', max: 2, windowMs: 1000 }], t + i), false)
  }
  assert.equal(allowAll([{ key: 'other-ip', max: 1, windowMs: 1000 }, { key: 'global', max: 2, windowMs: 1000 }], t), true)
  assert.equal(allowAll([{ key: 'third-ip', max: 1, windowMs: 1000 }, { key: 'global', max: 2, windowMs: 1000 }], t), true)
  assert.equal(allowAll([{ key: 'fourth-ip', max: 1, windowMs: 1000 }, { key: 'global', max: 2, windowMs: 1000 }], t), false)
})

test('a max of 0 disables that limit', () => {
  for (let i = 0; i < 100; i++) assert.equal(allowAll([{ key: 'off', max: 0, windowMs: 1000 }], 3_000_000), true)
})

test('a burst of 1000 concurrent requests gets exactly max through', async () => {
  const results = await Promise.all(
    Array.from({ length: 1000 }, () => Promise.resolve().then(() => allow('burst', 20, 60_000))),
  )
  assert.equal(results.filter(Boolean).length, 20)
})

test('TtlCache shares one load between concurrent callers and expires', async () => {
  const cache = new TtlCache<number>(1000)
  let loads = 0
  const load = () => Promise.resolve(++loads)
  const values = await Promise.all(Array.from({ length: 50 }, () => cache.get('s', load, 10)))
  assert.deepEqual(new Set(values), new Set([1]))
  assert.equal(loads, 1)
  assert.equal(await cache.get('s', load, 500), 1, 'still fresh')
  assert.equal(await cache.get('s', load, 1011), 2, 'expired, reloaded')
  cache.delete('s')
  assert.equal(await cache.get('s', load, 1012), 3, 'deleted, reloaded')
})

test('TtlCache does not keep failed loads', async () => {
  const cache = new TtlCache<number>(1000)
  await assert.rejects(cache.get('s', () => Promise.reject(new Error('down')), 10))
  await new Promise((r) => setImmediate(r))
  assert.equal(await cache.get('s', () => Promise.resolve(7), 20), 7)
})

test('rejected requests store nothing, so a flood of new keys cannot grow memory', () => {
  resetRateLimits()
  const T = 1_800_000_000_000
  assert.equal(allow('login-ip:9.9.9.9', 1, 60_000, T), true)
  const before = rateLimitKeyCount()
  // The IP is over its limit; each attempt names a new account.
  for (let i = 0; i < 1000; i++) {
    assert.equal(allowAll([{ key: 'login-ip:9.9.9.9', max: 1, windowMs: 60_000 }, { key: `login-account:${i}`, max: 5, windowMs: 60_000 }], T), false)
  }
  assert.equal(rateLimitKeyCount(), before)
})

test('the limiter stays bounded even when every key is recent', () => {
  resetRateLimits()
  const T = 1_800_000_000_000
  for (let i = 0; i < 50_010; i++) allow(`k:${i}`, 5, 60_000, T)
  assert.ok(rateLimitKeyCount() <= 50_000, `kept ${rateLimitKeyCount()} keys`)
  // The most recent keys survive pruning, the oldest go first.
  assert.equal(allowAll([{ key: 'k:50009', max: 1, windowMs: 60_000 }], T), false)
  assert.equal(allowAll([{ key: 'k:0', max: 1, windowMs: 60_000 }], T), true)
})
