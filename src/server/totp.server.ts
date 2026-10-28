import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

// Time-based one-time passwords (RFC 6238, the 6-digit codes from Google
// Authenticator, 1Password, Authy and similar apps), using only node:crypto.

const STEP_SECONDS = 30
const DIGITS = 6
// Accept the previous and next 30-second step too, for clock drift.
const WINDOW = 1

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '')
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const char of clean) {
    const index = ALPHABET.indexOf(char)
    if (index < 0) throw new Error('Invalid base32 character.')
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

// 160-bit secret, the size RFC 4226 recommends for HMAC-SHA1.
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20))
}

export function totpStep(nowMs = Date.now()): number {
  return Math.floor(nowMs / 1000 / STEP_SECONDS)
}

export function totpAt(secret: string, step: number, digits = DIGITS): string {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(step))
  const hmac = createHmac('sha1', base32Decode(secret)).update(counter).digest()
  const offset = hmac[hmac.length - 1]! & 0x0f
  const binary = hmac.readUInt32BE(offset) & 0x7fffffff
  return String(binary % 10 ** digits).padStart(digits, '0')
}

// Returns the matching time step, or null. A step at or before lastUsedStep
// is rejected so a code can't be replayed.
export function verifyTotp(secret: string, input: string, lastUsedStep: number | null, nowMs = Date.now()): number | null {
  const code = input.replace(/\s/g, '')
  if (!/^\d{6}$/.test(code)) return null
  const current = totpStep(nowMs)
  for (let step = current - WINDOW; step <= current + WINDOW; step++) {
    if (lastUsedStep !== null && step <= lastUsedStep) continue
    if (timingSafeEqual(Buffer.from(totpAt(secret, step)), Buffer.from(code))) return step
  }
  return null
}

// The link authenticator apps understand (tap it on a phone, or it's what a
// QR code would contain).
export function otpauthUrl(secret: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`)
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_SECONDS) })
  return `otpauth://totp/${label}?${params}`
}

// "abcd-efgh-jkmn": 12 characters from an alphabet without look-alikes.
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'

export function newRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const bytes = randomBytes(12)
    const chars = [...bytes].map((b) => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]).join('')
    return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`
  })
}

export function normalizeRecoveryCode(input: string): string {
  const chars = input.toLowerCase().replace(/[^a-z0-9]/g, '')
  return chars.length === 12 ? `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}` : ''
}

export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(normalizeRecoveryCode(code)).digest('hex')
}
