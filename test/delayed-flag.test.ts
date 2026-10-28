import { test } from 'node:test'
import assert from 'node:assert/strict'
import { delayedFlag, SPINNER_DELAY_MS, SPINNER_MINIMUM_MS, type Clock } from '../src/lib/delayed-flag.ts'

// A clock that only moves when told to.
function fakeClock() {
  let now = 0
  let next = 1
  const timers = new Map<number, { at: number; fn: () => void }>()
  const clock: Clock = {
    setTimeout: (fn, ms) => {
      const id = next++
      timers.set(id, { at: now + ms, fn })
      return id
    },
    clearTimeout: (id) => void timers.delete(id as number),
    now: () => now,
  }
  const advance = (ms: number) => {
    const until = now + ms
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      timers.delete(due[0])
      now = due[1].at
      due[1].fn()
    }
    now = until
  }
  return { clock, advance, pending: () => timers.size }
}

function setup() {
  const { clock, advance, pending } = fakeClock()
  const changes: Array<[number, boolean]> = []
  const flag = delayedFlag((shown) => changes.push([clock.now(), shown]), { clock })
  return { flag, advance, changes, pending }
}

test('a quick action never shows a spinner', () => {
  const { flag, advance, changes, pending } = setup()
  flag.set(true)
  advance(SPINNER_DELAY_MS - 50)
  flag.set(false)
  advance(2000)
  assert.deepEqual(changes, [])
  assert.equal(pending(), 0)
})

test('a slow action shows it after the delay, and hides it when done', () => {
  const { flag, advance, changes } = setup()
  flag.set(true)
  advance(2000)
  flag.set(false)
  assert.deepEqual(changes, [
    [SPINNER_DELAY_MS, true],
    [2000, false],
  ])
})

test('once shown, it stays at least the minimum, so it never blinks', () => {
  const { flag, advance, changes } = setup()
  flag.set(true)
  advance(SPINNER_DELAY_MS + 20) // just past the delay
  flag.set(false)
  advance(2000)
  assert.deepEqual(changes, [
    [SPINNER_DELAY_MS, true],
    [SPINNER_DELAY_MS + SPINNER_MINIMUM_MS, false],
  ])
})

test('busy again while waiting out the minimum keeps it showing, without a gap', () => {
  const { flag, advance, changes } = setup()
  flag.set(true)
  advance(SPINNER_DELAY_MS + 20)
  flag.set(false)
  advance(100)
  flag.set(true)
  advance(3000)
  assert.deepEqual(changes, [[SPINNER_DELAY_MS, true]])
  flag.set(false)
  assert.deepEqual(changes.at(-1), [SPINNER_DELAY_MS + 20 + 100 + 3000, false])
})

test('rapid busy toggles that each finish quickly show nothing', () => {
  const { flag, advance, changes } = setup()
  for (let i = 0; i < 10; i++) {
    flag.set(true)
    advance(100)
    flag.set(false)
    advance(50)
  }
  assert.deepEqual(changes, [])
})

test('dispose cancels anything waiting', () => {
  const { flag, advance, changes, pending } = setup()
  flag.set(true)
  flag.dispose()
  advance(2000)
  assert.deepEqual(changes, [])
  assert.equal(pending(), 0)
})
