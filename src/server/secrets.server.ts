import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { now } from './db.server.ts'

// Connector keys entered in Integrations, encrypted with DESK_SECRET_KEY
// (AES-256-GCM). The connector and field name are bound in as associated
// data, so a stored key can't be moved to another field or connector. Values
// never leave the server: the dashboard only learns whether one is set and
// its last four characters.

export class SecretError extends Error {}

export interface StoredSecret {
  ciphertext: string
  iv: string
  tag: string
  key_id: string
  last4: string
}

// Short fingerprint of the key, stored with each value, so a changed
// DESK_SECRET_KEY reads as "re-enter your keys" instead of a decryption failure.
export function keyId(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 12)
}

function aad(connector: string, field: string): Buffer {
  return Buffer.from(`desk-connector:${connector}:${field}`)
}

export function encryptSecret(key: Buffer, connector: string, field: string, value: string): StoredSecret {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(aad(connector, field))
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    key_id: keyId(key),
    last4: lastFour(value),
  }
}

export function decryptSecret(key: Buffer, connector: string, field: string, stored: StoredSecret): string {
  if (stored.key_id !== keyId(key)) {
    throw new SecretError(`The saved ${field} was encrypted with a different DESK_SECRET_KEY. Enter it again.`)
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(stored.iv, 'base64'))
    decipher.setAAD(aad(connector, field))
    decipher.setAuthTag(Buffer.from(stored.tag, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(stored.ciphertext, 'base64')), decipher.final()]).toString('utf8')
  } catch {
    throw new SecretError(`The saved ${field} couldn’t be decrypted. Enter it again.`)
  }
}

// Enough to recognise a key ("ends in 4f2a") without revealing it. Short
// values show nothing.
export function lastFour(value: string): string {
  return value.length >= 12 ? value.slice(-4) : ''
}

export function saveSecret(
  db: DatabaseSync,
  key: Buffer,
  input: { connector: string; field: string; value: string; userId: string | null },
) {
  const s = encryptSecret(key, input.connector, input.field, input.value)
  db.prepare(
    `INSERT INTO connector_secrets (connector, field, ciphertext, iv, tag, key_id, last4, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (connector, field) DO UPDATE SET
       ciphertext = excluded.ciphertext, iv = excluded.iv, tag = excluded.tag, key_id = excluded.key_id,
       last4 = excluded.last4, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  ).run(input.connector, input.field, s.ciphertext, s.iv, s.tag, s.key_id, s.last4, now(), input.userId)
}

export function deleteSecret(db: DatabaseSync, connector: string, field: string) {
  db.prepare('DELETE FROM connector_secrets WHERE connector = ? AND field = ?').run(connector, field)
}

export function storedSecret(db: DatabaseSync, connector: string, field: string): StoredSecret | null {
  const row = db
    .prepare('SELECT ciphertext, iv, tag, key_id, last4 FROM connector_secrets WHERE connector = ? AND field = ?')
    .get(connector, field) as StoredSecret | undefined
  return row ? { ...row } : null
}

export interface SecretState {
  set: boolean
  source: 'env' | 'dashboard' | null
  last4: string
  // The stored value can't be read with the current DESK_SECRET_KEY.
  stale: boolean
}

// What the dashboard may know about a secret field. Never the value.
export function secretState(
  db: DatabaseSync,
  key: Buffer | null,
  input: { connector: string; field: string; envValue: string | undefined },
): SecretState {
  if (input.envValue) return { set: true, source: 'env', last4: lastFour(input.envValue), stale: false }
  const stored = storedSecret(db, input.connector, input.field)
  if (!stored) return { set: false, source: null, last4: '', stale: false }
  return { set: true, source: 'dashboard', last4: stored.last4, stale: !key || stored.key_id !== keyId(key) }
}

// The value to use: the environment wins over the dashboard.
export function readSecret(
  db: DatabaseSync,
  key: Buffer | null,
  input: { connector: string; field: string; envValue: string | undefined },
): string | null {
  if (input.envValue) return input.envValue
  const stored = storedSecret(db, input.connector, input.field)
  if (!stored) return null
  if (!key) throw new SecretError(`DESK_SECRET_KEY isn’t set, so the saved ${input.field} can’t be read.`)
  return decryptSecret(key, input.connector, input.field, stored)
}

// Error text that may reach a log or an admin's screen, with any of these
// values cut out (upstream APIs sometimes echo a key back).
export function scrub(message: string, secrets: Array<string | null | undefined>): string {
  let out = message
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join('[redacted]')
  return out
}
