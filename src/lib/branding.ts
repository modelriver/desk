// Branding and SEO set from Settings, stored in the database and layered over
// support.config.json: the name, the home page's title and description, one
// brand colour, two fonts and the corner style. Everything is validated
// before it reaches CSS or a page's <head>.
//
// Pure module (no I/O) so the server, the Settings page and tests share it.

import type { Palette, SiteConfig } from './site-config.ts'

export interface Branding {
  name?: string
  // The home page's <title>. Other pages are "Page — name".
  homeTitle?: string
  // The home page's meta description, and the fallback for pages without one.
  description?: string
  // Write the name beside the logo in the header. Off for a logo that already spells it.
  showName?: boolean
  brandColor?: string
  bodyFont?: string
  headingFont?: string
  corners?: CornerId
}

export const LIMITS = { name: 60, homeTitle: 70, description: 200 } as const

// Search engines show about this much of a title and a description.
export const RECOMMENDED = { title: 60, description: 160 } as const

// --- Fonts ---
// A short list from Google Fonts, each with the weights the app uses that the
// family actually has (Google Fonts refuses a weight a family lacks).

export interface FontChoice {
  id: string
  label: string
  // The family as Google Fonts names it; null for the built-in stacks.
  family: string | null
  weights: number[]
}

export const BODY_FONTS: FontChoice[] = [
  { id: 'system', label: 'System default', family: null, weights: [] },
  { id: 'inter', label: 'Inter', family: 'Inter', weights: [400, 500, 600, 700] },
  { id: 'geist', label: 'Geist', family: 'Geist', weights: [400, 500, 600, 700] },
  { id: 'ibm-plex-sans', label: 'IBM Plex Sans', family: 'IBM Plex Sans', weights: [400, 500, 600, 700] },
  { id: 'dm-sans', label: 'DM Sans', family: 'DM Sans', weights: [400, 500, 600, 700] },
  { id: 'source-sans-3', label: 'Source Sans 3', family: 'Source Sans 3', weights: [400, 500, 600, 700] },
  { id: 'nunito-sans', label: 'Nunito Sans', family: 'Nunito Sans', weights: [400, 500, 600, 700] },
]

export const HEADING_FONTS: FontChoice[] = [
  { id: 'default', label: 'Default serif', family: null, weights: [] },
  { id: 'body', label: 'Same as body text', family: null, weights: [] },
  { id: 'source-serif-4', label: 'Source Serif 4', family: 'Source Serif 4', weights: [400, 500, 600] },
  { id: 'lora', label: 'Lora', family: 'Lora', weights: [400, 500, 600] },
  { id: 'newsreader', label: 'Newsreader', family: 'Newsreader', weights: [400, 500, 600] },
  { id: 'fraunces', label: 'Fraunces', family: 'Fraunces', weights: [400, 500, 600] },
  { id: 'playfair-display', label: 'Playfair Display', family: 'Playfair Display', weights: [400, 500, 600] },
  { id: 'merriweather', label: 'Merriweather', family: 'Merriweather', weights: [400, 700] },
]

export function googleFontUrl(font: FontChoice): string | null {
  if (!font.family) return null
  return `https://fonts.googleapis.com/css2?family=${font.family.replace(/ /g, '+')}:wght@${font.weights.join(';')}&display=swap`
}

// --- Corners ---

export const CORNERS = [
  { id: 'subtle', label: 'Subtle', radius: '0.25rem' },
  { id: 'default', label: 'Default', radius: '0.625rem' },
  { id: 'round', label: 'Round', radius: '1rem' },
] as const

export type CornerId = (typeof CORNERS)[number]['id']

// --- Validation ---

const HEX = /^#[0-9a-f]{6}$/i

export class BrandingError extends Error {}

// Checks a form's input and returns only what was set; blank fields are
// dropped, so clearing one goes back to support.config.json.
export function parseBranding(input: unknown): Branding {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new BrandingError('Branding must be an object.')
  const raw = input as Record<string, unknown>
  const out: Branding = {}

  const text = (key: 'name' | 'homeTitle' | 'description', label: string) => {
    const value = raw[key]
    if (value === undefined || value === null) return
    if (typeof value !== 'string') throw new BrandingError(`${label} must be text.`)
    const clean = value.replace(/\s+/g, ' ').trim()
    if (!clean) return
    if (clean.length > LIMITS[key]) throw new BrandingError(`${label} must be ${LIMITS[key]} characters or fewer.`)
    out[key] = clean
  }
  text('name', 'The name')
  text('homeTitle', 'The home page title')
  text('description', 'The description')

  if (raw.showName !== undefined && raw.showName !== null) {
    if (typeof raw.showName !== 'boolean') throw new BrandingError('showName must be true or false.')
    out.showName = raw.showName
  }
  if (raw.brandColor !== undefined && raw.brandColor !== null && raw.brandColor !== '') {
    if (typeof raw.brandColor !== 'string' || !HEX.test(raw.brandColor.trim())) throw new BrandingError('The brand colour must be a hex colour like #238a92.')
    out.brandColor = raw.brandColor.trim().toLowerCase()
  }
  const pick = <T extends { id: string }>(key: 'bodyFont' | 'headingFont' | 'corners', list: readonly T[], label: string) => {
    const value = raw[key]
    if (value === undefined || value === null || value === '') return
    if (typeof value !== 'string' || !list.some((o) => o.id === value)) throw new BrandingError(`Choose one of the listed ${label}.`)
    ;(out as Record<string, string>)[key] = value
  }
  pick('bodyFont', BODY_FONTS, 'body fonts')
  pick('headingFont', HEADING_FONTS, 'heading fonts')
  pick('corners', CORNERS, 'corner styles')
  return out
}

// --- Titles ---

// "Billing — Acme Help". The home page uses its own title instead.
export function pageTitle(page: string, name: string): string {
  return page === name ? name : `${page} — ${name}`
}

// --- Applying it ---

// support.config.json's settings with the Settings page's on top.
export function applyBranding(config: SiteConfig, b: Branding): SiteConfig {
  const next = structuredClone(config)
  if (b.name) next.brand.name = b.name
  if (b.brandColor) {
    Object.assign(next.theme.light, lightAccents(b.brandColor))
    Object.assign(next.theme.dark, darkAccents(b.brandColor))
  }
  const corners = CORNERS.find((c) => c.id === b.corners)
  if (corners) next.theme.radius = corners.radius

  const body = BODY_FONTS.find((f) => f.id === b.bodyFont)
  const heading = HEADING_FONTS.find((f) => f.id === b.headingFont)
  if (body?.family) next.fonts.sans = `'${body.family}', ${config.fonts.sans}`
  if (heading?.id === 'body') next.fonts.serif = next.fonts.sans
  else if (heading?.family) next.fonts.serif = `'${heading.family}', ${config.fonts.serif}`
  const sheets = [body, heading].flatMap((f) => (f ? [googleFontUrl(f)] : [])).filter((u): u is string => u !== null)
  next.fonts.stylesheets = [...new Set([...config.fonts.stylesheets, ...sheets])]
  return next
}

// --- Colours ---
// One brand colour gives buttons, links, focus rings and the soft highlight
// behind active items, in both colour schemes. Backgrounds, text and borders
// keep the theme's own neutrals.

type Accents = Pick<Palette, 'primary' | 'primaryHover' | 'primaryForeground' | 'accent' | 'accentForeground' | 'ring'>

export function lightAccents(hex: string): Accents {
  const [h, s, l] = toHsl(hex)
  const primary = normalizeHex(hex)
  return {
    primary,
    primaryHover: fromHsl(h, s, clamp(l - 8, 5, 90)),
    primaryForeground: readableOn(primary),
    accent: fromHsl(h, Math.min(s, 60), 95),
    accentForeground: fromHsl(h, Math.min(s, 70), 25),
    ring: primary,
  }
}

export function darkAccents(hex: string): Accents {
  const [h, s, l] = toHsl(hex)
  // Lifted so it stands out on a dark background.
  const primary = fromHsl(h, s, clamp(l + 12, 55, 72))
  const [, , pl] = toHsl(primary)
  return {
    primary,
    primaryHover: fromHsl(h, s, clamp(pl + 8, 60, 82)),
    primaryForeground: readableOn(primary),
    accent: fromHsl(h, Math.min(s, 45), 16),
    accentForeground: fromHsl(h, Math.min(s, 70), 80),
    ring: primary,
  }
}

// White or near-black text, whichever is easier to read on `hex`.
export function readableOn(hex: string): string {
  const dark = '#111111'
  return contrast(hex, '#ffffff') >= contrast(hex, dark) ? '#ffffff' : dark
}

export function contrast(a: string, b: string): number {
  const [la, lb] = [luminance(a), luminance(b)]
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((c) => {
    const v = c / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function rgb(hex: string): [number, number, number] {
  const n = Number.parseInt(normalizeHex(hex).slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function normalizeHex(hex: string): string {
  return hex.trim().toLowerCase()
}

function toHsl(hex: string): [number, number, number] {
  const [r, g, b] = rgb(hex).map((c) => c / 255) as [number, number, number]
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l * 100]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [h * 60, s * 100, l * 100]
}

function fromHsl(h: number, s: number, l: number): string {
  const sat = s / 100
  const light = l / 100
  const k = (n: number) => (n + h / 30) % 12
  const a = sat * Math.min(light, 1 - light)
  const f = (n: number) => light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return `#${[f(0), f(8), f(4)].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}
