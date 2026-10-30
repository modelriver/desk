import { createServerFn } from '@tanstack/react-start'
import { asObject } from './validate.ts'
import { requireUser } from '../server/auth.server.ts'
import { allowAll } from '../server/rate-limit.server.ts'
import { removeAsset, saveAsset, saveBranding } from '../server/branding.server.ts'
import { brandingSettings } from '../server/settings.server.ts'
import { ASSET_RULES, BRAND_ASSET_KINDS, type BrandAssetKind } from '../lib/brand-assets.ts'
import type { Branding } from '../lib/branding.ts'

const FIELDS = ['name', 'homeTitle', 'description', 'showName', 'brandColor', 'bodyFont', 'headingFont', 'corners'] as const satisfies ReadonlyArray<keyof Branding>

function limit(userId: string) {
  if (!allowAll([{ key: `branding:${userId}`, max: 60, windowMs: 10 * 60_000 }])) {
    throw new Error('That’s a lot of changes at once. Try again in a few minutes.')
  }
}

function assetKind(value: unknown): BrandAssetKind {
  const kind = BRAND_ASSET_KINDS.find((k) => k === value)
  if (!kind) throw new Error('Unknown image.')
  return kind
}

// Admins only: name, SEO and look from Settings. Only the fields sent change;
// a blank one goes back to support.config.json.
export const updateBranding = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const raw = asObject(input)
    const fields: Partial<Record<keyof Branding, unknown>> = {}
    for (const key of FIELDS) if (key in raw) fields[key] = raw[key]
    if (!Object.keys(fields).length) throw new Error('Nothing to save.')
    return fields
  })
  .handler(({ data }) => {
    const me = requireUser('admin')
    limit(me.id)
    saveBranding(data, me)
    return brandingSettings()
  })

// Admins only: the header logo (light or dark mode) or the favicon, as an SVG or PNG.
export const uploadBrandAsset = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    if (!(input instanceof FormData)) throw new Error('Expected an image.')
    const kind = assetKind(input.get('kind'))
    const file = input.get('file')
    if (!(file instanceof File) || file.size === 0) throw new Error('Choose an image.')
    if (file.size > ASSET_RULES[kind].maxPngBytes) throw new Error(`That file is too large: ${ASSET_RULES[kind].hint}`)
    return { kind, file }
  })
  .handler(async ({ data }) => {
    const me = requireUser('admin')
    limit(me.id)
    saveAsset(data.kind, new Uint8Array(await data.file.arrayBuffer()), me)
    return brandingSettings()
  })

export const removeBrandAsset = createServerFn({ method: 'POST' })
  .validator((input: unknown) => ({ kind: assetKind(asObject(input).kind) }))
  .handler(({ data }) => {
    const me = requireUser('admin')
    limit(me.id)
    removeAsset(data.kind, me)
    return brandingSettings()
  })
