import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { getDb, now } from './db.server.ts'
import { audit } from './integrations.server.ts'
import { parseBranding, type Branding } from '../lib/branding.ts'
import { BRAND_ASSET_KINDS, checkBrandImage, type BrandAssetKind, type BrandImageType } from '../lib/brand-assets.ts'

// The branding and SEO admins set in Settings, kept in app_settings next to
// the chat switch. site-config.server.ts lays them over support.config.json;
// `brandingVersion` tells it when to rebuild after a save.

const BRANDING_KEY = 'branding'
const ASSET_KEY: Record<BrandAssetKind, string> = { logo: 'brand_logo', 'logo-dark': 'brand_logo_dark', favicon: 'brand_favicon' }

export interface StoredAsset {
  type: BrandImageType
  // Base64 of the file.
  data: string
  // Short content hash, for cache-busting URLs.
  hash: string
  width: number | null
  height: number | null
  updatedAt: string
  updatedBy: string | null
}

let version = 0

export function brandingVersion(): number {
  return version
}

type Row = { value: string; updated_at: string; updated_by: string | null }

function row(db: DatabaseSync, key: string): Row | undefined {
  return db.prepare('SELECT value, updated_at, updated_by FROM app_settings WHERE key = ?').get(key) as Row | undefined
}

function put(db: DatabaseSync, key: string, value: string, user: { name: string }) {
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  ).run(key, value, now(), user.name)
}

// What's saved, or nothing. A row that no longer passes the checks (after an
// upgrade, say) is ignored rather than breaking every page.
export function readBranding(db: DatabaseSync = getDb()): Branding {
  const saved = row(db, BRANDING_KEY)
  if (!saved) return {}
  try {
    return parseBranding(JSON.parse(saved.value))
  } catch {
    return {}
  }
}

export function brandingChange(db: DatabaseSync = getDb()): { at: string; by: string | null } | null {
  const saved = row(db, BRANDING_KEY)
  return saved ? { at: saved.updated_at, by: saved.updated_by } : null
}

// Replaces the given fields. Blank ones go back to support.config.json.
export function saveBranding(fields: Partial<Record<keyof Branding, unknown>>, user: { id: string; name: string }, db: DatabaseSync = getDb()): Branding {
  const merged = parseBranding({ ...readBranding(db), ...fields })
  put(db, BRANDING_KEY, JSON.stringify(merged), user)
  audit(db, user, 'branding.updated', Object.keys(fields).join(', '))
  version++
  return merged
}

export function readAsset(kind: BrandAssetKind, db: DatabaseSync = getDb()): StoredAsset | null {
  const saved = row(db, ASSET_KEY[kind])
  if (!saved) return null
  try {
    const parsed = JSON.parse(saved.value) as Omit<StoredAsset, 'updatedAt' | 'updatedBy'>
    return { ...parsed, updatedAt: saved.updated_at, updatedBy: saved.updated_by }
  } catch {
    return null
  }
}

export function saveAsset(kind: BrandAssetKind, bytes: Uint8Array, user: { id: string; name: string }, db: DatabaseSync = getDb()): StoredAsset {
  const checked = checkBrandImage(kind, bytes)
  const asset = {
    ...checked,
    data: Buffer.from(bytes).toString('base64'),
    hash: createHash('sha256').update(bytes).digest('hex').slice(0, 12),
  }
  put(db, ASSET_KEY[kind], JSON.stringify(asset), user)
  audit(db, user, `branding.${kind}.uploaded`, kind)
  version++
  return readAsset(kind, db)!
}

export function removeAsset(kind: BrandAssetKind, user: { id: string; name: string }, db: DatabaseSync = getDb()) {
  const removed = db.prepare('DELETE FROM app_settings WHERE key = ?').run(ASSET_KEY[kind])
  if (removed.changes) {
    audit(db, user, `branding.${kind}.removed`, kind)
    version++
  }
}

// Where the browser loads an uploaded asset; the hash makes it safe to cache for good.
export function assetUrl(kind: BrandAssetKind, asset: Pick<StoredAsset, 'hash'>): string {
  return `/brand/${kind}?v=${asset.hash}`
}

// GET /brand/logo, /brand/logo-dark and /brand/favicon. With the current hash in ?v= it's cached
// for a year; without, briefly, so a replaced image shows up soon. The CSP
// keeps an SVG opened directly from running anything (server.mjs sends the
// same for /brand/ in production).
export function brandAssetResponse(name: string, v: string | null, { head = false } = {}): Response {
  const kind = BRAND_ASSET_KINDS.find((k) => k === name) ?? null
  const asset = kind ? readAsset(kind) : null
  if (!asset) return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
  const body = Buffer.from(asset.data, 'base64')
  return new Response(head ? null : body, {
    headers: {
      'Content-Type': asset.type,
      'Content-Length': String(body.length),
      'Cache-Control': v === asset.hash ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
      'Content-Security-Policy': BRAND_ASSET_CSP,
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

export const BRAND_ASSET_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox"
