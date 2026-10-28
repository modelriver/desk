import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  base32Decode,
  base32Encode,
  hashRecoveryCode,
  newRecoveryCodes,
  newTotpSecret,
  normalizeRecoveryCode,
  otpauthUrl,
  totpAt,
  totpStep,
  verifyTotp,
} from '../src/server/totp.server.ts'

// RFC 6238 appendix B: SHA-1 secret "12345678901234567890", 8-digit codes.
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'))

test('TOTP matches the RFC 6238 test vectors', () => {
  const vectors: Array<[number, string]> = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
  ]
  for (const [seconds, expected] of vectors) {
    assert.equal(totpAt(RFC_SECRET, totpStep(seconds * 1000), 8), expected, `T=${seconds}`)
  }
})

test('base32 round-trips and ignores spaces, dashes and case', () => {
  const bytes = Buffer.from('any random bytes!')
  const encoded = base32Encode(bytes)
  assert.deepEqual(base32Decode(encoded), bytes)
  assert.deepEqual(base32Decode(encoded.toLowerCase().replace(/(.{4})/g, '$1 ')), bytes)
  assert.throws(() => base32Decode('not*base32'))
  assert.match(newTotpSecret(), /^[A-Z2-7]{32}$/)
})

test('verifyTotp accepts the current and adjacent steps, and rejects replays', () => {
  const secret = newTotpSecret()
  const now = 1_800_000_000_000
  const step = totpStep(now)
  assert.equal(verifyTotp(secret, totpAt(secret, step), null, now), step)
  assert.equal(verifyTotp(secret, totpAt(secret, step - 1), null, now), step - 1, 'previous step (clock drift)')
  assert.equal(verifyTotp(secret, totpAt(secret, step + 1), null, now), step + 1, 'next step (clock drift)')
  assert.equal(verifyTotp(secret, totpAt(secret, step - 2), null, now), null, 'too old')
  assert.equal(verifyTotp(secret, totpAt(secret, step), step, now), null, 'same code twice')
  assert.equal(verifyTotp(secret, ` ${totpAt(secret, step).slice(0, 3)} ${totpAt(secret, step).slice(3)} `, null, now), step)
  assert.equal(verifyTotp(secret, 'abcdef', null, now), null)
  assert.equal(verifyTotp(secret, '12345', null, now), null)
})

test('otpauth link carries the secret, issuer and account', () => {
  const url = new URL(otpauthUrl('JBSWY3DPEHPK3PXP', 'sam@example.com', 'Acme Support'))
  assert.equal(url.protocol, 'otpauth:')
  assert.equal(url.host, 'totp')
  assert.equal(decodeURIComponent(url.pathname), '/Acme Support:sam@example.com')
  assert.equal(url.searchParams.get('secret'), 'JBSWY3DPEHPK3PXP')
  assert.equal(url.searchParams.get('issuer'), 'Acme Support')
})

test('recovery codes are unique, readable and hash the same however they are typed', () => {
  const codes = newRecoveryCodes()
  assert.equal(codes.length, 10)
  assert.equal(new Set(codes).size, 10)
  for (const c of codes) assert.match(c, /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/)
  const c = codes[0]!
  assert.equal(hashRecoveryCode(c.toUpperCase().replace(/-/g, ' ')), hashRecoveryCode(c))
  assert.equal(normalizeRecoveryCode('short'), '')
})
