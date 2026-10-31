// Site configuration: brand name, colours, fonts and font stylesheets.
// Read from support.config.json (or the file named by SUPPORT_CONFIG) and
// merged over the defaults below. Every value is validated before it is
// written into CSS or the Content-Security-Policy, so a config file can change
// the look of the app but cannot inject markup or scripts.
//
// Pure module (no I/O, no imports) so server.mjs, the app and tests share it.

export const COLOR_TOKENS = [
  'background',
  'foreground',
  'card',
  'muted',
  'mutedForeground',
  'border',
  'input',
  'primary',
  'primaryHover',
  'primaryForeground',
  'accent',
  'accentForeground',
  'destructive',
  'success',
  'ring',
] as const

export type ColorToken = (typeof COLOR_TOKENS)[number]
export type Palette = Record<ColorToken, string>

export interface SiteConfig {
  brand: {
    name: string
    // SVG files shown beside the name, as paths relative to the config file.
    // logoDark is used in dark mode; without it, logo is used in both.
    logo: string | null
    logoDark: string | null
  }
  theme: { radius: string; light: Palette; dark: Palette }
  fonts: {
    sans: string
    serif: string
    mono: string
    // CSS files that define @font-face rules, e.g. a Google Fonts URL.
    stylesheets: string[]
    // Extra origins the font files themselves load from, when they differ
    // from the stylesheet's origin. Google Fonts is added automatically.
    fontOrigins: string[]
  }
}

// The logo as the browser gets it: data: URLs of the SVG files, or null to
// show the default mark.
export type Logo = { light: string; dark: string | null } | null

// The header logo for each colour scheme. An uploaded logo replaces
// support.config.json's (and its dark version, which was made to match it);
// an uploaded dark-mode logo is used over whichever light one shows. A dark
// logo alone has nothing to pair with, so the Desk bot stays.
export function resolveLogo(uploaded: string | null, uploadedDark: string | null, fromFile: Logo): Logo {
  if (uploaded) return { light: uploaded, dark: uploadedDark }
  if (fromFile) return { light: fromFile.light, dark: uploadedDark ?? fromFile.dark }
  return null
}

export const DEFAULT_CONFIG: SiteConfig = {
  brand: { name: 'Help Center', logo: null, logoDark: null },
  theme: {
    radius: '0.625rem',
    light: {
      background: '#fbfaf8',
      foreground: '#1c1b19',
      card: '#ffffff',
      muted: '#f3f2ef',
      mutedForeground: '#6b6862',
      border: '#e7e5e0',
      input: '#dedbd5',
      primary: '#238a92',
      primaryHover: '#1d747b',
      primaryForeground: '#ffffff',
      accent: '#e8f3f4',
      accentForeground: '#155a60',
      destructive: '#c4321c',
      success: '#1e7b45',
      ring: '#238a92',
    },
    dark: {
      background: '#161615',
      foreground: '#ecebe8',
      card: '#1d1d1b',
      muted: '#242422',
      mutedForeground: '#a19e97',
      border: '#2e2d2a',
      input: '#3a3935',
      primary: '#3fb1ba',
      primaryHover: '#63c4cc',
      primaryForeground: '#0d2a2d',
      accent: '#17363a',
      accentForeground: '#9fdbe0',
      destructive: '#ff8a7a',
      success: '#6fd39a',
      ring: '#3fb1ba',
    },
  },
  fonts: {
    sans: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
    serif: "Charter, 'Bitstream Charter', 'Iowan Old Style', 'Sitka Text', Cambria, Georgia, serif",
    mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    stylesheets: [],
    fontOrigins: [],
  },
}

const COLOR =
  /^(#[0-9a-f]{3,4}|#[0-9a-f]{6}|#[0-9a-f]{8}|(rgb|rgba|hsl|hsla|oklch|oklab|lab|lch)\(\s*[0-9.%+\-\s,/a-z]{1,80}\))$/i
const FONT_FAMILY = /^[A-Za-z0-9 _'".,-]{1,300}$/
const RADIUS = /^(0|\d{1,2}(\.\d{1,3})?(rem|px|em))$/
const MAX_STYLESHEETS = 5
// A relative path to an .svg file: no URL scheme, no absolute path, no "..".
const SVG_PATH = /^(?!\/)(?![a-z][a-z0-9+.-]*:)(?!.*(^|\/)\.\.(\/|$))[\w ./-]{1,200}\.svg$/i

export class SiteConfigError extends Error {}

// Merges a parsed JSON value over the defaults, collecting every problem so
// the error lists them all at once.
export function parseSiteConfig(input: unknown): SiteConfig {
  const errors: string[] = []
  const root = isObject(input) ? input : (input === undefined ? {} : (errors.push('config must be a JSON object'), {}))
  const config = structuredClone(DEFAULT_CONFIG)

  const brand = section(root, 'brand', errors)
  if (brand.name !== undefined) {
    if (typeof brand.name === 'string' && brand.name.trim() && brand.name.length <= 60) config.brand.name = brand.name.trim()
    else errors.push('brand.name must be 1-60 characters')
  }
  for (const key of ['logo', 'logoDark'] as const) {
    const value = brand[key]
    if (value === undefined || value === null) continue
    if (typeof value === 'string' && SVG_PATH.test(value.trim())) config.brand[key] = value.trim()
    else errors.push(`brand.${key} must be a relative path to an .svg file, like "./brand/logo.svg"`)
  }

  const theme = section(root, 'theme', errors)
  if (theme.radius !== undefined) {
    if (typeof theme.radius === 'string' && RADIUS.test(theme.radius)) config.theme.radius = theme.radius
    else errors.push('theme.radius must look like "0.5rem", "8px" or "0"')
  }
  for (const mode of ['light', 'dark'] as const) {
    const palette = section(theme, mode, errors, `theme.${mode}`)
    for (const [key, value] of Object.entries(palette)) {
      if (!(COLOR_TOKENS as readonly string[]).includes(key)) {
        errors.push(`theme.${mode}.${key} is not a known colour (use one of: ${COLOR_TOKENS.join(', ')})`)
      } else if (typeof value !== 'string' || !COLOR.test(value.trim())) {
        errors.push(`theme.${mode}.${key} must be a hex, rgb(), hsl() or oklch() colour`)
      } else {
        config.theme[mode][key as ColorToken] = value.trim()
      }
    }
  }

  const fonts = section(root, 'fonts', errors)
  for (const key of ['sans', 'serif', 'mono'] as const) {
    if (fonts[key] === undefined) continue
    const value = fonts[key]
    if (typeof value === 'string' && FONT_FAMILY.test(value.trim())) config.fonts[key] = value.trim()
    else errors.push(`fonts.${key} must be a font-family list such as "Inter, sans-serif"`)
  }
  if (fonts.stylesheets !== undefined) {
    const list = Array.isArray(fonts.stylesheets) ? fonts.stylesheets : null
    if (!list || list.length > MAX_STYLESHEETS) errors.push(`fonts.stylesheets must be a list of up to ${MAX_STYLESHEETS} URLs`)
    else config.fonts.stylesheets = list.flatMap((u, i) => httpsUrl(u, `fonts.stylesheets[${i}]`, errors, 'href'))
  }
  if (fonts.fontOrigins !== undefined) {
    const list = Array.isArray(fonts.fontOrigins) ? fonts.fontOrigins : null
    if (!list || list.length > 10) errors.push('fonts.fontOrigins must be a list of up to 10 origins')
    else config.fonts.fontOrigins = list.flatMap((u, i) => httpsUrl(u, `fonts.fontOrigins[${i}]`, errors, 'origin'))
  }

  if (errors.length) throw new SiteConfigError(`Invalid site config:\n- ${errors.join('\n- ')}`)
  return config
}

// The CSS variables the stylesheet reads, for both colour schemes.
export function themeCss(config: SiteConfig): string {
  const vars = (palette: Palette) => COLOR_TOKENS.map((t) => `--${kebab(t)}:${palette[t]};`).join('')
  const common =
    `--radius:${config.theme.radius};` +
    `--app-font-sans:${config.fonts.sans};--app-font-serif:${config.fonts.serif};--app-font-mono:${config.fonts.mono};`
  return (
    `:root{${common}${vars(config.theme.light)}color-scheme:light}` +
    `@media (prefers-color-scheme: dark){:root{${vars(config.theme.dark)}color-scheme:dark}}`
  )
}

// Origins to allow in the CSP for the configured font stylesheets and files.
export function fontCspSources(config: SiteConfig): { style: string[]; font: string[] } {
  const style = unique(config.fonts.stylesheets.map((u) => new URL(u).origin))
  const font = [...config.fonts.fontOrigins, ...style]
  // Google Fonts serves the CSS and the font files from different hosts.
  if (style.includes('https://fonts.googleapis.com')) font.push('https://fonts.gstatic.com')
  return { style, font: unique(font) }
}

function section(obj: Record<string, unknown>, key: string, errors: string[], label = key): Record<string, unknown> {
  const value = obj[key]
  if (value === undefined) return {}
  if (isObject(value)) return value
  errors.push(`${label} must be an object`)
  return {}
}

function httpsUrl(value: unknown, label: string, errors: string[], form: 'href' | 'origin'): string[] {
  try {
    if (typeof value !== 'string') throw new Error()
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error()
    return [form === 'origin' ? url.origin : url.href]
  } catch {
    errors.push(`${label} must be an https:// URL`)
    return []
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function kebab(token: string): string {
  return token.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}
