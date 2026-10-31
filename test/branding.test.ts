import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyBranding, BODY_FONTS, contrast, darkAccents, googleFontUrl, HEADING_FONTS, lightAccents, pageTitle, parseBranding, readableOn } from '../src/lib/branding.ts'
import { checkBrandImage, unsafeSvg } from '../src/lib/brand-assets.ts'
import { DEFAULT_CONFIG } from '../src/lib/site-config.ts'

// The database path is read when the modules first load, so point it at a
// throwaway file before loading them. No support.config.json: the defaults.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-branding-'))
process.env.DATABASE_PATH = path.join(dir, 'desk.db')
delete process.env.SUPPORT_CONFIG
const cwd = process.cwd()
process.chdir(dir)
const { getSiteConfig } = await import('../src/server/site-config.server.ts')
const { brandAssetResponse, readBranding, removeAsset, saveAsset, saveBranding } = await import('../src/server/branding.server.ts')
const { getDb } = await import('../src/server/db.server.ts')

after(() => {
  process.chdir(cwd)
  fs.rmSync(dir, { recursive: true, force: true })
})

const db = getDb()
db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('u1', 'sam@acme.test', 'Sam', 'x', 'admin', '2026-10-29T00:00:00.000Z')").run()
const sam = { id: 'u1', name: 'Sam' }

// A 64 × 64 PNG header: signature, then IHDR's width and height.
function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(64)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}
const svg = (inner = '<circle cx="5" cy="5" r="5"/>') => new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${inner}</svg>`)

test('every page but the home page is "Page — Name"', () => {
  assert.equal(pageTitle('Billing', 'Acme Help'), 'Billing — Acme Help')
  assert.equal(pageTitle('Acme Help', 'Acme Help'), 'Acme Help')
})

test('the form is checked and blank fields are dropped', () => {
  assert.deepEqual(parseBranding({ name: '  Acme   Help ', homeTitle: '', description: '   ', brandColor: '#1F6FEB', bodyFont: 'inter', showName: false }), {
    name: 'Acme Help',
    brandColor: '#1f6feb',
    bodyFont: 'inter',
    showName: false,
  })
  assert.throws(() => parseBranding({ brandColor: 'red' }), /hex colour/)
  assert.throws(() => parseBranding({ bodyFont: 'comic-sans' }), /listed body fonts/)
  assert.throws(() => parseBranding({ corners: 'pill' }), /corner styles/)
  assert.throws(() => parseBranding({ name: 'x'.repeat(61) }), /60 characters/)
  assert.throws(() => parseBranding({ description: 7 }), /must be text/)
})

test('a brand colour gives readable accents in both themes', () => {
  for (const hex of ['#238a92', '#1f6feb', '#f5c518', '#111111', '#ffffff', '#e11d48']) {
    for (const accents of [lightAccents(hex), darkAccents(hex)]) {
      assert.ok(contrast(accents.primary, accents.primaryForeground) >= 3, `${hex}: button text on ${accents.primary}`)
      assert.ok(contrast(accents.accent, accents.accentForeground) >= 4.5, `${hex}: highlight text on ${accents.accent}`)
      for (const value of Object.values(accents)) assert.match(value, /^#[0-9a-f]{6}$/)
    }
  }
  assert.equal(readableOn('#ffffff'), '#111111')
  assert.equal(readableOn('#111111'), '#ffffff')
  // Mid-tone colours where WCAG alone would pick black but white reads better.
  for (const hex of ['#059669', '#e0582f', '#238a92']) assert.equal(readableOn(hex), '#ffffff', hex)
  // Light ones keep dark text, and white is never picked below 3:1.
  for (const hex of ['#f5c518', '#22c55e', '#f97316']) assert.equal(readableOn(hex), '#111111', hex)
  assert.equal(lightAccents('#1F6FEB').primary, '#1f6feb')
  // Every brand colour, black and white included, gives a button that stands
  // out from the page in both modes (the themes' backgrounds).
  for (const hex of ['#000000', '#ffffff', '#808080', '#111111', '#fafafa', '#fff8c4', '#238a92', '#1c1917']) {
    assert.ok(contrast(lightAccents(hex).primary, '#fbfaf8') >= 1.5, `${hex}: light-mode button on the page`)
    assert.ok(contrast(darkAccents(hex).primary, '#161615') >= 3, `${hex}: dark-mode button on the page`)
  }
  // Black, white and grey are monochrome: ink buttons, near-white in dark mode.
  assert.deepEqual([lightAccents('#000000').primary, darkAccents('#000000').primary], ['#111111', '#f2f2f2'])
  assert.deepEqual([lightAccents('#ffffff').primary, darkAccents('#ffffff').primary], ['#111111', '#f2f2f2'])
  assert.equal(darkAccents('#000000').primaryForeground, '#111111')
  // A pale colour is deepened so it shows on white.
  assert.notEqual(lightAccents('#fff8c4').primary, '#fff8c4')
  // Vivid colours are calmed in dark mode instead of glowing.
  assert.equal(darkAccents('#059669').primary, '#42d7a9')
  assert.equal(darkAccents('#238a92').primary, '#46c8d3')
})

test('fonts load from Google Fonts with weights each family has', () => {
  for (const font of [...BODY_FONTS, ...HEADING_FONTS]) {
    const url = googleFontUrl(font)
    if (!font.family) assert.equal(url, null)
    else assert.match(url!, /^https:\/\/fonts\.googleapis\.com\/css2\?family=[A-Za-z0-9+]+:wght@\d+(;\d+)*&display=swap$/)
  }
  const config = applyBranding(DEFAULT_CONFIG, { bodyFont: 'ibm-plex-sans', headingFont: 'body', corners: 'round', brandColor: '#1f6feb', name: 'Acme Help' })
  assert.equal(config.brand.name, 'Acme Help')
  assert.match(config.fonts.sans, /^'IBM Plex Sans', ui-sans-serif/)
  assert.equal(config.fonts.serif, config.fonts.sans)
  assert.equal(config.theme.radius, '1rem')
  assert.equal(config.theme.light.primary, '#1f6feb')
  assert.equal(config.theme.light.background, DEFAULT_CONFIG.theme.light.background)
  assert.deepEqual(config.fonts.stylesheets, ['https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&display=swap'])
  // Nothing set: the config is unchanged.
  assert.deepEqual(applyBranding(DEFAULT_CONFIG, {}), DEFAULT_CONFIG)
})

test('logos and favicons must be a safe SVG or a sensible PNG', () => {
  assert.deepEqual(checkBrandImage('logo', svg()), { type: 'image/svg+xml', width: null, height: null })
  assert.deepEqual(checkBrandImage('logo', png(240, 64)), { type: 'image/png', width: 240, height: 64 })
  assert.deepEqual(checkBrandImage('favicon', png(512, 512)), { type: 'image/png', width: 512, height: 512 })
  assert.throws(() => checkBrandImage('favicon', png(512, 256)), /must be square/)
  assert.throws(() => checkBrandImage('favicon', png(16, 16)), /at least 48/)
  assert.throws(() => checkBrandImage('logo', png(100, 20)), /blurry/)
  assert.throws(() => checkBrandImage('logo', new TextEncoder().encode('GIF89a…')), /SVG or a PNG/)
  assert.throws(() => checkBrandImage('logo', svg('<script>alert(1)</script>')), /contains a script/)
  assert.equal(unsafeSvg('<svg onload="alert(1)">'), 'has event handlers')
  assert.equal(unsafeSvg('<svg><a href="javascript:alert(1)">x</a></svg>'), 'has a javascript: link')
  assert.equal(unsafeSvg('<svg><foreignObject><div/></foreignObject></svg>'), 'embeds HTML')
  assert.equal(unsafeSvg('<svg><image href="https://evil.test/x.png"/></svg>'), 'links to another file')
  assert.equal(unsafeSvg('<svg><use xlink:href="#a"/><image href="data:image/png;base64,AAAA"/></svg>'), null)
  assert.equal(unsafeSvg('<svg style="fill:url(#g)"><rect style="background:url(https://evil.test)"/></svg>'), 'loads another file')
})

test('saved branding is laid over support.config.json at once', () => {
  assert.equal(getSiteConfig().config.brand.name, 'Help Center')
  saveBranding({ name: 'Acme Help', homeTitle: 'Acme Help Center', description: 'Answers about Acme.', showName: false, brandColor: '#1f6feb' }, sam)
  const site = getSiteConfig()
  assert.equal(site.config.brand.name, 'Acme Help')
  assert.equal(site.fileConfig.brand.name, 'Help Center')
  assert.deepEqual(site.seo, { homeTitle: 'Acme Help Center', description: 'Answers about Acme.' })
  // Hidden only once there's a logo to show instead.
  assert.equal(site.showName, true)
  saveAsset('logo', svg(), sam)
  assert.equal(getSiteConfig().showName, false)
  removeAsset('logo', sam)
  assert.match(site.css, /--primary:#1f6feb;/)

  // Only the fields sent change; a blank one goes back to the default.
  saveBranding({ homeTitle: '' }, sam)
  assert.deepEqual(readBranding(), { name: 'Acme Help', description: 'Answers about Acme.', showName: false, brandColor: '#1f6feb' })
  assert.equal(getSiteConfig().seo.homeTitle, null)

  const audited = db.prepare("SELECT action, target FROM admin_audit WHERE action = 'branding.updated' ORDER BY id").all()
  assert.equal(audited.length, 2)
})

test('an uploaded logo replaces the bot and becomes the tab icon until a favicon is uploaded', async () => {
  assert.equal(getSiteConfig().logo, null)
  assert.equal(getSiteConfig().favicon, null)
  const logo = saveAsset('logo', svg(), sam)
  assert.deepEqual(getSiteConfig().logo, { light: `/brand/logo?v=${logo.hash}`, dark: null })
  assert.deepEqual(getSiteConfig().favicon, { href: `/brand/logo?v=${logo.hash}`, type: 'image/svg+xml' })

  const favicon = saveAsset('favicon', png(512, 512), sam)
  assert.deepEqual(getSiteConfig().favicon, { href: `/brand/favicon?v=${favicon.hash}`, type: 'image/png' })

  const res = brandAssetResponse('logo', logo.hash)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'image/svg+xml')
  assert.match(res.headers.get('cache-control')!, /immutable/)
  assert.match(res.headers.get('content-security-policy')!, /default-src 'none'.*sandbox/)
  assert.equal(new TextDecoder().decode(await res.arrayBuffer()), new TextDecoder().decode(svg()))
  assert.match(brandAssetResponse('logo', 'old').headers.get('cache-control')!, /max-age=300/)
  assert.equal(brandAssetResponse('other', null).status, 404)

  removeAsset('logo', sam)
  removeAsset('favicon', sam)
  assert.equal(getSiteConfig().logo, null)
  assert.equal(brandAssetResponse('logo', null).status, 404)
})

test('a dark-mode logo pairs with whichever light logo shows', async () => {
  const { resolveLogo } = await import('../src/server/site-config.server.ts')
  const file = { light: 'data:file-light', dark: 'data:file-dark' }
  assert.deepEqual(resolveLogo('/up', '/up-dark', file), { light: '/up', dark: '/up-dark' })
  // An uploaded logo replaces the file's pair, dark version included.
  assert.deepEqual(resolveLogo('/up', null, file), { light: '/up', dark: null })
  assert.deepEqual(resolveLogo(null, '/up-dark', file), { light: 'data:file-light', dark: '/up-dark' })
  assert.deepEqual(resolveLogo(null, null, file), file)
  // Nothing to pair a dark logo with: the Desk bot.
  assert.equal(resolveLogo(null, '/up-dark', null), null)

  const light = saveAsset('logo', svg(), sam)
  const dark = saveAsset('logo-dark', svg('<rect width="10" height="10" fill="#fff"/>'), sam)
  assert.deepEqual(getSiteConfig().logo, { light: `/brand/logo?v=${light.hash}`, dark: `/brand/logo-dark?v=${dark.hash}` })
  assert.equal(brandAssetResponse('logo-dark', dark.hash).status, 200)
  assert.throws(() => checkBrandImage('logo-dark', png(100, 20)), /dark-mode logo is only 20 px tall/)
  removeAsset('logo', sam)
  removeAsset('logo-dark', sam)
  assert.equal(getSiteConfig().logo, null)
})

test("the home page's heading, line and example can be set, and fall back to Desk's own", () => {
  assert.deepEqual(parseBranding({ homeHeading: '  Hi there ', homeIntro: '', askExample: 'For example: how do I add a fallback model?' }), {
    homeHeading: 'Hi there',
    askExample: 'For example: how do I add a fallback model?',
  })
  assert.throws(() => parseBranding({ askExample: 'x'.repeat(121) }), /120 characters/)
  assert.deepEqual(getSiteConfig().home, { heading: null, intro: null, example: null })
  saveBranding({ homeHeading: 'Hi there', askExample: 'For example: how do I add a fallback model?' }, sam)
  assert.deepEqual(getSiteConfig().home, { heading: 'Hi there', intro: null, example: 'For example: how do I add a fallback model?' })
  saveBranding({ homeHeading: '', askExample: '' }, sam)
  assert.deepEqual(getSiteConfig().home, { heading: null, intro: null, example: null })
})
