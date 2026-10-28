import { createHash, randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto'

const scrypt = (password: string, salt: Buffer, keylen: number, options: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) =>
    scryptCb(password, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key))),
  )

const N = 32768
const R = 8
const P = 1
const KEYLEN = 64
const MAXMEM = 64 * 1024 * 1024

// Stored as scrypt$N$r$p$salt$hash so parameters can be raised later.
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await scrypt(password, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM })
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$')
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, n, r, p, saltB64, hashB64] = stored.split('$')
  if (algo !== 'scrypt' || !saltB64 || !hashB64) return false
  const expected = Buffer.from(hashB64, 'base64')
  const key = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: MAXMEM,
  })
  return key.length === expected.length && timingSafeEqual(key, expected)
}

// A temporary password for a new team member: 16 characters from an
// alphabet without look-alikes (no 0/O, 1/l/I), in groups of four so it's
// easy to read out or type. About 80 bits of randomness.
const TEMP_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'
export function newTemporaryPassword(): string {
  const chars = Array.from({ length: 16 }, () => TEMP_ALPHABET[randomInt(TEMP_ALPHABET.length)])
  return [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join('')).join('-')
}

export function newToken(): string {
  return randomBytes(32).toString('base64url')
}

// Tokens are stored hashed so a leaked database cannot be replayed as cookies.
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export const MIN_PASSWORD_LENGTH = 10
