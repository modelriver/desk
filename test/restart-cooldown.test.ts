import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { cooldownSeconds, recordEnd, resetCooldowns, restartWaitSeconds } from '../src/server/restart-cooldown.server.ts'

const T = 1_800_000_000_000
const S = 1000

test('first restart is free, then 60 s, 2 min, 4 min, capped at 15 min', () => {
  assert.equal(cooldownSeconds([T], 1, T), 0)
  assert.equal(cooldownSeconds([T - 10 * S, T], 1, T), 60)
  assert.equal(cooldownSeconds([T - 20 * S, T - 10 * S, T], 1, T), 120)
  assert.equal(cooldownSeconds([T - 30 * S, T - 20 * S, T - 10 * S, T], 1, T), 240)
  const many = Array.from({ length: 12 }, (_, i) => T - i * S)
  assert.equal(cooldownSeconds(many, 1, T), 15 * 60)
})

test('the wait counts down from the last end and ignores ends older than an hour', () => {
  assert.equal(cooldownSeconds([T - 10 * S, T], 1, T + 45 * S), 15)
  assert.equal(cooldownSeconds([T - 10 * S, T], 1, T + 60 * S), 0)
  assert.equal(cooldownSeconds([T - 61 * 60 * S, T], 1, T), 0, 'the old end has expired')
})

beforeEach(() => resetCooldowns())

test('a browser gets one free restart, then waits', () => {
  const keys = { device: 'dev-a', ip: '203.0.113.9' }
  recordEnd(keys, T)
  assert.equal(restartWaitSeconds(keys, T + S), 0, 'first new chat right away')
  recordEnd(keys, T + 5 * S)
  assert.equal(restartWaitSeconds(keys, T + 5 * S), 60)
  assert.equal(restartWaitSeconds(keys, T + 50 * S), 15)
})

test('clearing cookies does not dodge the wait: the IP rule catches up', () => {
  const ip = '203.0.113.10'
  // Every end looks like a brand-new browser.
  for (let i = 0; i < 4; i++) recordEnd({ device: `fresh-${i}`, ip }, T + i * S)
  assert.equal(restartWaitSeconds({ device: 'fresh-new', ip }, T + 4 * S), 59)
})

test('people sharing an IP get a few free restarts before the IP rule applies', () => {
  const ip = '198.51.100.20'
  for (let i = 0; i < 3; i++) recordEnd({ device: `coworker-${i}`, ip }, T + i * S)
  assert.equal(restartWaitSeconds({ device: 'coworker-x', ip }, T + 3 * S), 0)
})
