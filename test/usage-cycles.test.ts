import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cycleLabel, formatCycleDay, recentCycles } from '../src/lib/usage-cycles.ts'

test('cycles run from the anchor day, back to when the install was set up', () => {
  assert.deepEqual(recentCycles('2026-10-30T15:00:00Z', '2026-11-30T00:00:00Z', '2026-10'), [
    { start: '2026-11-30', end: '2026-12-30' },
    { start: '2026-10-30', end: '2026-11-30' },
    { start: '2026-09-30', end: '2026-10-30' },
  ])
  assert.deepEqual(recentCycles('2026-10-30T15:00:00Z', '2026-11-30T00:00:00Z', '2026-11'), [
    { start: '2026-11-30', end: '2026-12-30' },
    { start: '2026-10-30', end: '2026-11-30' },
  ])
})

test('cycles clamp to shorter months like ModelRiver does', () => {
  assert.deepEqual(recentCycles('2026-01-31T00:00:00Z', '2026-03-31T00:00:00Z', '2026-02'), [
    { start: '2026-03-31', end: '2026-04-30' },
    { start: '2026-02-28', end: '2026-03-31' },
    { start: '2026-01-31', end: '2026-02-28' },
  ])
  // Oct 30 anchor through February
  assert.deepEqual(recentCycles('2025-10-30T00:00:00Z', '2026-02-28T00:00:00Z', '2026-02').slice(0, 2), [
    { start: '2026-02-28', end: '2026-03-30' },
    { start: '2026-01-30', end: '2026-02-28' },
  ])
})

test('at most 24 earlier cycles', () => {
  assert.equal(recentCycles('2020-01-15T00:00:00Z', '2026-11-15T00:00:00Z', '2020-01').length, 25)
})

test('labels', () => {
  assert.equal(cycleLabel({ start: '2026-10-30', end: '2026-11-30' }), 'Oct 30 – Nov 30, 2026')
  assert.equal(cycleLabel({ start: '2026-12-30', end: '2027-01-30' }), 'Dec 30, 2026 – Jan 30, 2027')
  assert.equal(formatCycleDay('2026-11-30T00:00:00Z'), 'Nov 30')
  assert.equal(formatCycleDay('2026-11-30'), 'Nov 30')
})
