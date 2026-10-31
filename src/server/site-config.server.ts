import fs from 'node:fs'
import path from 'node:path'
import { parseSiteConfig, resolveLogo, SiteConfigError, themeCss, type Logo, type SiteConfig } from '../lib/site-config.ts'

// Shared with Settings, which previews a logo before it's saved.
export { resolveLogo }
import { applyBranding, type Branding } from '../lib/branding.ts'
import { faviconSvg } from '../lib/favicon.ts'
import { assetUrl, brandingVersion, readAsset, readBranding } from './branding.server.ts'

// support.config.json in the working directory, or the file named by
// SUPPORT_CONFIG. Missing file = defaults. Read once per process: restart to
// pick up changes. Branding saved in Settings is layered on top (getSiteConfig).
export function siteConfigPath(): string {
  return path.resolve(process.env.SUPPORT_CONFIG ?? 'support.config.json')
}

export function readSiteConfigFile(file = siteConfigPath()): SiteConfig {
  if (!fs.existsSync(file)) {
    if (process.env.SUPPORT_CONFIG) throw new Error(`SUPPORT_CONFIG points to ${file}, which does not exist.`)
    return parseSiteConfig(undefined)
  }
  let json: unknown
  try {
    json = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${(err as Error).message}`)
  }
  return parseSiteConfig(json)
}

const MAX_LOGO_BYTES = 100 * 1024

// The logo as a data: URL, read once at startup. It is shown with <img>,
// where an SVG's scripts and external loads never run, so the file needs no
// sanitizing; it only has to be a real SVG inside the config file's folder.
export function readLogo(relativePath: string, configFile = siteConfigPath()): string {
  const dir = path.dirname(configFile)
  const file = path.resolve(dir, relativePath)
  if (!file.startsWith(dir + path.sep)) throw new SiteConfigError(`Logo ${relativePath} must be inside ${dir}.`)
  if (!fs.existsSync(file)) throw new SiteConfigError(`Logo file ${file} does not exist.`)
  const bytes = fs.readFileSync(file)
  if (bytes.length > MAX_LOGO_BYTES) throw new SiteConfigError(`Logo ${file} is over 100 KB; simplify or minify the SVG.`)
  if (!/<svg[\s>]/i.test(bytes.toString('utf8'))) throw new SiteConfigError(`Logo ${file} is not an SVG file.`)
  return `data:image/svg+xml;base64,${bytes.toString('base64')}`
}

function readLogos(config: SiteConfig, configFile: string): Logo {
  if (!config.brand.logo) return null
  return {
    light: readLogo(config.brand.logo, configFile),
    dark: config.brand.logoDark ? readLogo(config.brand.logoDark, configFile) : null,
  }
}

export interface ResolvedSiteConfig {
  // support.config.json with the Settings page's branding on top.
  config: SiteConfig
  // support.config.json alone, for "Reset" and the Settings form's placeholders.
  fileConfig: SiteConfig
  // Its logos, which show again when an uploaded one is removed.
  fileLogo: Logo
  branding: Branding
  css: string
  logo: Logo
  // The tab icon: the uploaded favicon, else the logo; null for the Desk bot at /favicon.svg.
  favicon: { href: string; type: string } | null
  // Write the name beside the logo in the header (always, without a logo).
  showName: boolean
  // The home page's title and description from Settings, or null for the defaults.
  seo: { homeTitle: string | null; description: string | null }
  // The home page's hero text from Settings, or null for HOME_DEFAULTS.
  home: { heading: string | null; intro: string | null; example: string | null }
}

let cached: { version: number; value: ResolvedSiteConfig } | undefined
let fileCache: { config: SiteConfig; logo: Logo } | undefined

// support.config.json is read once per process (restart to pick up changes);
// what Settings saves applies at once.
export function getSiteConfig(): ResolvedSiteConfig {
  const version = brandingVersion()
  if (cached?.version === version) return cached.value
  if (!fileCache) {
    const file = siteConfigPath()
    const config = readSiteConfigFile(file)
    fileCache = { config, logo: readLogos(config, file) }
  }
  const branding = readBranding()
  const config = applyBranding(fileCache.config, branding)
  const logoAsset = readAsset('logo')
  const darkAsset = readAsset('logo-dark')
  const faviconAsset = readAsset('favicon')
  const logo = resolveLogo(
    logoAsset && assetUrl('logo', logoAsset),
    darkAsset && assetUrl('logo-dark', darkAsset),
    fileCache.logo,
  )
  const value: ResolvedSiteConfig = {
    config,
    fileConfig: fileCache.config,
    fileLogo: fileCache.logo,
    branding,
    css: themeCss(config),
    logo,
    favicon: faviconAsset
      ? { href: assetUrl('favicon', faviconAsset), type: faviconAsset.type }
      : logoAsset
        ? { href: assetUrl('logo', logoAsset), type: logoAsset.type }
        : logo
          ? { href: logo.light, type: 'image/svg+xml' }
          : null,
    // Hiding the name needs a logo to take its place; with the Desk bot it always shows.
    showName: branding.showName !== false || logo === null,
    seo: { homeTitle: branding.homeTitle ?? null, description: branding.description ?? null },
    home: { heading: branding.homeHeading ?? null, intro: branding.homeIntro ?? null, example: branding.askExample ?? null },
  }
  cached = { version, value }
  return value
}

// For server.mjs: fail at startup, not on the first page view, if a logo is missing or invalid.
export function checkSiteConfig() {
  getSiteConfig()
}

// GET /favicon.svg: the Desk bot in this theme's colours, cached for a day
// (the config itself is read once, at start).
export function faviconResponse(): Response {
  const { light, dark } = getSiteConfig().config.theme
  return new Response(faviconSvg({ ink: light.foreground, paper: light.card }, { ink: dark.foreground, paper: dark.card }), {
    headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' },
  })
}
