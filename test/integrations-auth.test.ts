import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

// The dashboard hides pages from people who can't use them, but only a check
// inside each server function stops a direct call. Every server function must
// require a signed-in user, apart from the ones visitors and sign-in use.
const FUNCTIONS_DIR = new URL('../src/functions/', import.meta.url)
// Visitor-facing (help center and chat widget): they check the visitor cookie instead.
// customer-portal.ts: the customer portal, which checks their own sign-in
// (a key from their email, or a code) instead; see the test below.
const PUBLIC_FILES = new Set(['chat.ts', 'help.ts', 'customer-portal.ts'])
// Sign-in steps, which run before there is a user.
const PUBLIC_FUNCTIONS = new Set(['getMe', 'signIn', 'verifyTwoFactorCode', 'completeTwoFactorSetup', 'signOut'])
// Every function in these files is for admins only.
const ADMIN_FILES = new Set(['data.ts', 'integrations.ts', 'settings.ts'])

function handlers(file: string): { name: string; body: string }[] {
  const source = fs.readFileSync(new URL(file, FUNCTIONS_DIR), 'utf8')
  const starts = [...source.matchAll(/export const (\w+) = createServerFn/g)]
  return starts.map((m, i) => {
    const end = starts[i + 1]?.index ?? source.length
    return { name: m[1]!, body: source.slice(source.indexOf('.handler(', m.index), end) }
  })
}

test('every dashboard server function checks who is calling', () => {
  const files = fs.readdirSync(FUNCTIONS_DIR).filter((f) => f.endsWith('.ts') && f !== 'validate.ts' && !PUBLIC_FILES.has(f))
  let checked = 0
  for (const file of files) {
    for (const { name, body } of handlers(file)) {
      if (PUBLIC_FUNCTIONS.has(name)) continue
      const check = ADMIN_FILES.has(file) ? /requireUser\('admin'\)/ : /requireUser\(/
      assert.match(body, check, `${file} ${name} must call ${ADMIN_FILES.has(file) ? "requireUser('admin')" : 'requireUser()'}`)
      checked++
    }
  }
  assert.ok(checked >= 30, `only found ${checked} server functions; did the file layout change?`)
})

test('the visitor-facing verification functions never return the full email', () => {
  const source = fs.readFileSync(new URL('../src/functions/chat.ts', import.meta.url), 'utf8')
  for (const name of ['requestEmailCode', 'confirmEmailCode', 'applyIdentity']) {
    const start = source.indexOf(`export const ${name}`)
    assert.ok(start >= 0, name)
    // The handler only: the validator returns the visitor's own input.
    const end = source.indexOf('export const', start + 10)
    const body = source.slice(source.indexOf('.handler(', start), end)
    for (const ret of body.match(/return \{[^}]*\}/g) ?? []) assert.match(ret, /maskEmail\(/, `${name}: ${ret}`)
  }
})

test('the customer portal only shows a ticket to its own, proven address', () => {
  // Each one either proves the address (a key from their email, or a code) or
  // reads the session that proving it started; only signing out needs neither.
  for (const { name, body } of handlers('customer-portal.ts')) {
    if (name === 'signOutCustomer') continue
    assert.match(body, /redeemTicketLink|customerSessionEmail|sessionEmail\(\)|issueCustomerCode|confirmCode/, name)
  }
  // Tickets are only shown with a matching address, and never with the row id or full email.
  const source = fs.readFileSync(new URL('customer-portal.ts', FUNCTIONS_DIR), 'utf8')
  assert.match(source, /const \{ id: _id, email: _email, \.\.\.rest \} = t/)
  for (const line of source.split('\n').filter((l) => l.includes('return view('))) assert.match(line, /, (data\.)?email\)$/, line)
})
