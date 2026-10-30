// The header logo and the favicon, uploaded from Settings. Pure checks on the
// bytes, shared by the server and tests.
//
// Both are shown with <img> or <link rel=icon>, where an SVG's scripts never
// run. They're also served at /brand/…, which a visitor could open directly,
// so an SVG with scripts, event handlers or external references is refused
// (and the route sends a CSP that blocks them anyway).

// logo-dark replaces the logo in dark mode; without one, the logo shows in both.
export type BrandAssetKind = 'logo' | 'logo-dark' | 'favicon'

export const BRAND_ASSET_KINDS: readonly BrandAssetKind[] = ['logo', 'logo-dark', 'favicon']

const LABEL: Record<BrandAssetKind, string> = { logo: 'logo', 'logo-dark': 'dark-mode logo', favicon: 'favicon' }

export type BrandImageType = 'image/svg+xml' | 'image/png'

// A logo's height in the header, whatever its shape; the width follows.
export const LOGO_HEIGHT = 26
// On a phone, where the header is narrower.
export const PHONE_LOGO_HEIGHT = LOGO_HEIGHT - 6

export const ASSET_RULES = {
  logo: { maxSvgBytes: 100 * 1024, maxPngBytes: 512 * 1024, hint: `SVG preferred, cropped close to the artwork. It’s shown ${LOGO_HEIGHT} px tall (${PHONE_LOGO_HEIGHT} px on phones), as wide as its shape needs; a PNG should be at least 52 px tall.` },
  'logo-dark': { maxSvgBytes: 100 * 1024, maxPngBytes: 512 * 1024, hint: 'Shown instead of the logo in dark mode. Same size as the logo.' },
  favicon: { maxSvgBytes: 100 * 1024, maxPngBytes: 256 * 1024, hint: 'A square SVG, or a square PNG of 512 × 512 px (at least 48 × 48).' },
} as const

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

export interface CheckedImage {
  type: BrandImageType
  // PNG only; an SVG scales.
  width: number | null
  height: number | null
}

export class BrandAssetError extends Error {}

export function checkBrandImage(kind: BrandAssetKind, bytes: Uint8Array): CheckedImage {
  const rules = ASSET_RULES[kind]
  const label = LABEL[kind]
  if (isPng(bytes)) {
    if (bytes.length > rules.maxPngBytes) throw new BrandAssetError(`A PNG ${label} must be ${rules.maxPngBytes / 1024} KB or smaller.`)
    const { width, height } = pngSize(bytes)
    if (kind === 'favicon') {
      if (width !== height) throw new BrandAssetError(`The favicon must be square; this one is ${width} × ${height} px.`)
      if (width < 48) throw new BrandAssetError(`The favicon must be at least 48 × 48 px; this one is ${width} × ${height} px.`)
    } else if (height < 32) {
      throw new BrandAssetError(`The ${label} is only ${height} px tall and would look blurry. Use an SVG, or a PNG at least 52 px tall.`)
    }
    return { type: 'image/png', width, height }
  }
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  if (/<svg[\s>]/i.test(text)) {
    if (bytes.length > rules.maxSvgBytes) throw new BrandAssetError(`An SVG ${label} must be ${rules.maxSvgBytes / 1024} KB or smaller; simplify or minify it.`)
    const problem = unsafeSvg(text)
    if (problem) throw new BrandAssetError(`This SVG can’t be used: it ${problem}. Export it again as a plain SVG.`)
    return { type: 'image/svg+xml', width: null, height: null }
  }
  throw new BrandAssetError('Upload an SVG or a PNG file.')
}

// What makes an SVG unsafe to serve from this site, or null if it's fine.
export function unsafeSvg(text: string): string | null {
  if (/<script[\s>/]/i.test(text)) return 'contains a script'
  if (/<foreignObject[\s>/]/i.test(text)) return 'embeds HTML'
  if (/\son[a-z]+\s*=/i.test(text)) return 'has event handlers'
  if (/javascript:/i.test(text)) return 'has a javascript: link'
  // Images and fonts inside the SVG must be embedded, not fetched.
  if (/(?:xlink:)?href\s*=\s*["']\s*(?!#|data:image\/)/i.test(text)) return 'links to another file'
  if (/url\(\s*["']?\s*(?!#|data:image\/)/i.test(text)) return 'loads another file'
  if (/<!ENTITY/i.test(text)) return 'declares entities'
  return null
}

function isPng(bytes: Uint8Array): boolean {
  return bytes.length > 24 && PNG_MAGIC.every((b, i) => bytes[i] === b)
}

// From the IHDR chunk, which always comes first.
function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}
