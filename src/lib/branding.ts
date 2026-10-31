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
  // The home page's hero: its heading, the line under it, and the example in
  // the question box. Blank uses HOME_DEFAULTS.
  homeHeading?: string
  homeIntro?: string
  askExample?: string
}

export const LIMITS = { name: 60, homeTitle: 70, description: 200, homeHeading: 60, homeIntro: 240, askExample: 120 } as const

// The home page's hero text when Settings leaves it blank.
export const HOME_DEFAULTS = {
  heading: 'How can we help?',
  intro: 'Ask in your own words. The answer comes from our guides and links to the articles it used. If you need a person, our team can join the chat.',
  example: 'For example: how do I export my whole workspace?',
  // The line's default while "Talk with a person" is off in Settings.
  introWithoutTeam:
    'Ask in your own words. The answer comes from our guides and links to the articles it used. If you need our team, you can raise a ticket.',
  // ...and new tickets are off too.
  introAnswersOnly: 'Ask in your own words. The answer comes from our guides and links to the articles it used.',
} as const

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

  const text = (key: 'name' | 'homeTitle' | 'description' | 'homeHeading' | 'homeIntro' | 'askExample', label: string) => {
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
  text('homeHeading', 'The home page heading')
  text('homeIntro', 'The line under the heading')
  text('askExample', 'The example question')

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

// Below this saturation a colour reads as black, white or grey: it has no hue
// to carry into highlights, so it's treated as monochrome, like Desk's own theme.
const NEUTRAL_SATURATION = 8

// Ink buttons for a black, white or grey brand: near-black in light mode,
// near-white in dark mode, on soft grey highlights.
const MONO_LIGHT: Accents = { primary: '#111111', primaryHover: '#333333', primaryForeground: '#ffffff', accent: '#f0f0f0', accentForeground: '#171717', ring: '#111111' }
const MONO_DARK: Accents = { primary: '#f2f2f2', primaryHover: '#d4d4d4', primaryForeground: '#111111', accent: '#2c2c2c', accentForeground: '#ededed', ring: '#f2f2f2' }

export function lightAccents(hex: string): Accents {
  const [h, s, l0] = toHsl(hex)
  if (s < NEUTRAL_SATURATION) return { ...MONO_LIGHT }
  // A very pale colour would vanish on a white page: deepen it, a step at a
  // time (yellows stay bright longest), until it stands out.
  let l = l0
  while (l > 10 && contrast(fromHsl(h, s, l), '#ffffff') < 1.6) l -= 3
  const primary = l === l0 ? normalizeHex(hex) : fromHsl(h, s, l)
  return {
    primary,
    // Darker on hover, or lighter for a colour already close to black.
    primaryHover: fromHsl(h, s, l < 20 ? l + 10 : clamp(l - 8, 5, 90)),
    primaryForeground: readableOn(primary),
    accent: fromHsl(h, Math.min(s, 60), 95),
    accentForeground: fromHsl(h, Math.min(s, 70), 25),
    ring: primary,
  }
}

const DARK_SATURATION = 65

export function darkAccents(hex: string): Accents {
  const [h, s, l] = toHsl(hex)
  if (s < NEUTRAL_SATURATION) return { ...MONO_DARK }
  // Lifted so it stands out on a dark background, with the saturation capped:
  // a vivid colour made this light glows (emerald would turn neon mint).
  const sat = Math.min(s, DARK_SATURATION)
  const primary = fromHsl(h, sat, clamp(l + 12, 55, 72))
  const [, , pl] = toHsl(primary)
  return {
    primary,
    primaryHover: fromHsl(h, sat, clamp(pl + 8, 60, 82)),
    primaryForeground: readableOn(primary),
    accent: fromHsl(h, Math.min(s, 45), 16),
    accentForeground: fromHsl(h, Math.min(s, 70), 80),
    ring: primary,
  }
}

// White or near-black text, whichever is easier to read on `hex`. The WCAG
// ratio alone picks black on mid-tone colours like emerald or orange, where
// white reads better; APCA (the perceptual contrast model behind WCAG 3)
// judges that the way people see it. White wins when APCA prefers it and it
// still meets 3:1; otherwise the higher WCAG ratio decides.
export function readableOn(hex: string): string {
  const white = '#ffffff'
  const dark = '#111111'
  if (contrast(hex, white) >= 3 && Math.abs(apca(white, hex)) >= Math.abs(apca(dark, hex))) return white
  return contrast(hex, white) >= contrast(hex, dark) ? white : dark
}

// APCA lightness contrast (0.0.98G-4g) of text on a background, about -108 to 106.
export function apca(text: string, background: string): number {
  const y = (hex: string) => {
    const [r, g, b] = rgb(hex).map((c) => (c / 255) ** 2.4) as [number, number, number]
    const lum = 0.2126729 * r + 0.7151522 * g + 0.072175 * b
    return lum < 0.022 ? lum + (0.022 - lum) ** 1.414 : lum
  }
  const txt = y(text)
  const bg = y(background)
  if (Math.abs(bg - txt) < 0.0005) return 0
  if (bg > txt) {
    const s = (bg ** 0.56 - txt ** 0.57) * 1.14
    return s < 0.1 ? 0 : (s - 0.027) * 100
  }
  const s = (bg ** 0.65 - txt ** 0.62) * 1.14
  return s > -0.1 ? 0 : (s + 0.027) * 100
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
