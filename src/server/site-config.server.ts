import fs from 'node:fs'
import path from 'node:path'
import { parseSiteConfig, SiteConfigError, themeCss, type Logo, type SiteConfig } from '../lib/site-config.ts'

// support.config.json in the working directory, or the file named by
// SUPPORT_CONFIG. Missing file = defaults. Read once per process: restart to
// pick up changes.
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

let cached: { config: SiteConfig; css: string; logo: Logo } | undefined

export function getSiteConfig() {
  if (!cached) {
    const file = siteConfigPath()
    const config = readSiteConfigFile(file)
    cached = { config, css: themeCss(config), logo: readLogos(config, file) }
  }
  return cached
}

// For server.mjs: fail at startup, not on the first page view, if a logo is missing or invalid.
export function checkSiteConfig() {
  getSiteConfig()
}
