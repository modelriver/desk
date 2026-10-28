import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CONFIG, fontCspSources, parseSiteConfig, SiteConfigError, themeCss } from '../src/lib/site-config.ts'

test('a missing or empty config gives the defaults', () => {
  assert.deepEqual(parseSiteConfig(undefined), DEFAULT_CONFIG)
  assert.deepEqual(parseSiteConfig({}), DEFAULT_CONFIG)
})

test('partial overrides merge over the defaults', () => {
  const c = parseSiteConfig({
    brand: { name: 'Acme Support' },
    theme: { radius: '6px', dark: { primary: 'oklch(0.7 0.12 200)' } },
    fonts: { sans: 'Inter, sans-serif' },
  })
  assert.equal(c.brand.name, 'Acme Support')
  assert.equal(c.theme.radius, '6px')
  assert.equal(c.theme.dark.primary, 'oklch(0.7 0.12 200)')
  assert.equal(c.theme.light.primary, DEFAULT_CONFIG.theme.light.primary, 'untouched tokens keep defaults')
  assert.equal(c.fonts.sans, 'Inter, sans-serif')
  assert.equal(c.fonts.serif, DEFAULT_CONFIG.fonts.serif)
})

test('values that could break out of CSS are rejected', () => {
  const bad = [
    { theme: { light: { primary: 'red;} body{display:none' } } },
    { theme: { light: { primary: 'url(https://evil.example/x)' } } },
    { theme: { radius: '1rem; color: red' } },
    { fonts: { sans: 'Inter; } * { color: red' } },
    { fonts: { serif: 'Georgia</style><script>alert(1)</script>' } },
  ]
  for (const input of bad) assert.throws(() => parseSiteConfig(input), SiteConfigError, JSON.stringify(input))
})

test('unknown colour tokens and wrong types are reported together', () => {
  try {
    parseSiteConfig({ theme: { light: { sparkle: '#fff', primary: 42 } }, brand: 'x' })
    assert.fail('expected an error')
  } catch (err) {
    assert.ok(err instanceof SiteConfigError)
    assert.match(err.message, /theme\.light\.sparkle is not a known colour/)
    assert.match(err.message, /theme\.light\.primary must be/)
    assert.match(err.message, /brand must be an object/)
  }
})

test('font stylesheets must be https URLs', () => {
  assert.throws(() => parseSiteConfig({ fonts: { stylesheets: ['http://fonts.example/a.css'] } }), SiteConfigError)
  assert.throws(() => parseSiteConfig({ fonts: { stylesheets: ['javascript:alert(1)'] } }), SiteConfigError)
  assert.throws(() => parseSiteConfig({ fonts: { stylesheets: ['https://user:pw@fonts.example/a.css'] } }), SiteConfigError)
  const c = parseSiteConfig({ fonts: { stylesheets: ['https://fonts.bunny.net/css?family=inter:400'] } })
  assert.deepEqual(c.fonts.stylesheets, ['https://fonts.bunny.net/css?family=inter:400'])
})

test('theme CSS has every token for both colour schemes', () => {
  const css = themeCss(parseSiteConfig({ theme: { light: { primary: '#123456' } } }))
  assert.match(css, /^:root\{--radius:0\.625rem;--app-font-sans:/)
  assert.match(css, /--primary:#123456;/)
  assert.match(css, /--muted-foreground:/)
  assert.match(css, /@media \(prefers-color-scheme: dark\)\{:root\{--background:#161615;/)
})

test('CSP sources cover the stylesheet hosts, and Google Fonts files', () => {
  const sources = fontCspSources(
    parseSiteConfig({
      fonts: {
        stylesheets: ['https://fonts.googleapis.com/css2?family=Inter', 'https://cdn.example.com/fonts.css'],
        fontOrigins: ['https://files.example.com'],
      },
    }),
  )
  assert.deepEqual(sources.style, ['https://fonts.googleapis.com', 'https://cdn.example.com'])
  assert.deepEqual(sources.font.sort(), [
    'https://cdn.example.com',
    'https://files.example.com',
    'https://fonts.googleapis.com',
    'https://fonts.gstatic.com',
  ])
})

test('brand.logo and brand.logoDark take relative .svg paths only', () => {
  const ok = parseSiteConfig({ brand: { logo: './brand/logo.svg', logoDark: 'brand/logo-dark.SVG' } })
  assert.equal(ok.brand.logo, './brand/logo.svg')
  assert.equal(ok.brand.logoDark, 'brand/logo-dark.SVG')
  assert.equal(parseSiteConfig({}).brand.logo, null)
  for (const bad of ['https://evil.example/logo.svg', 'data:image/svg+xml,<svg/>', '/etc/logo.svg', '../outside/logo.svg', 'brand/../../logo.svg', 'logo.png', 'javascript:alert(1).svg']) {
    assert.throws(() => parseSiteConfig({ brand: { logo: bad } }), /brand\.logo must be a relative path/, bad)
  }
})

test('logo files are read as SVG data URLs from inside the config folder', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { readLogo } = await import('../src/server/site-config.server.ts')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-logo-'))
  const configFile = path.join(dir, 'support.config.json')
  fs.mkdirSync(path.join(dir, 'brand'))
  fs.writeFileSync(path.join(dir, 'brand', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>')
  fs.writeFileSync(path.join(dir, 'brand', 'fake.svg'), 'not really an image')
  fs.writeFileSync(path.join(dir, 'brand', 'huge.svg'), '<svg>' + 'x'.repeat(101 * 1024) + '</svg>')

  const url = readLogo('./brand/logo.svg', configFile)
  assert.match(url, /^data:image\/svg\+xml;base64,/)
  assert.match(Buffer.from(url.split(',')[1]!, 'base64').toString(), /<svg/)
  assert.throws(() => readLogo('brand/missing.svg', configFile), /does not exist/)
  assert.throws(() => readLogo('brand/fake.svg', configFile), /not an SVG/)
  assert.throws(() => readLogo('brand/huge.svg', configFile), /over 100 KB/)
  assert.throws(() => readLogo('../escape.svg', configFile), /must be inside/)
  fs.rmSync(dir, { recursive: true })
})
