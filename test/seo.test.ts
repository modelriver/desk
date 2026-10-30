import { test } from 'node:test'
import assert from 'node:assert/strict'
import { articleData, articlesDescription, excerpt, fullDescription, jsonLd, pageHead, sectionDescription, sectionEntries, siteFrom, websiteData } from '../src/lib/seo.ts'

const site = { brandName: 'Acme Help', siteUrl: 'https://help.acme.test' }
const metaOf = (head: ReturnType<typeof pageHead>, key: string) =>
  head.meta.find((m) => m.name === key || m.property === key || (key === 'title' && 'title' in m))
const value = (head: ReturnType<typeof pageHead>, key: string) => {
  const m = metaOf(head, key)
  return m && ('title' in m ? m.title : m.content)
}

test('every page gets a title, description, canonical, Open Graph and Twitter tags', () => {
  const head = pageHead({ ...site, path: '/articles/billing', title: 'Billing', description: 'Plans and invoices' })
  assert.equal(value(head, 'title'), 'Billing — Acme Help')
  assert.equal(value(head, 'description'), 'Plans and invoices')
  assert.equal(value(head, 'og:type'), 'website')
  assert.equal(value(head, 'og:title'), 'Billing')
  assert.equal(value(head, 'og:description'), 'Plans and invoices')
  assert.equal(value(head, 'og:site_name'), 'Acme Help')
  assert.equal(value(head, 'og:url'), 'https://help.acme.test/articles/billing')
  assert.equal(value(head, 'twitter:card'), 'summary')
  assert.equal(value(head, 'twitter:title'), 'Billing')
  assert.equal(value(head, 'robots'), 'index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1')
  assert.equal(value(head, 'author'), 'Acme Help')
  assert.equal(value(head, 'publisher'), 'Acme Help')
  assert.equal(value(head, 'og:locale'), 'en_US')
  assert.deepEqual(head.links, [{ rel: 'canonical', href: 'https://help.acme.test/articles/billing' }])
})

test('keywords are de-duplicated and blanks dropped', () => {
  const head = pageHead({ ...site, path: '/x', title: 'X', keywords: ['Billing', null, 'billing', ' ', 'Acme Help'] })
  assert.equal(value(head, 'keywords'), 'Billing, Acme Help')
  assert.equal(metaOf(pageHead({ ...site, path: '/x', title: 'X' }), 'keywords'), undefined)
})

test('the home page is titled with the brand alone, or its own title from Settings', () => {
  assert.equal(value(pageHead({ ...site, path: '/', title: 'Acme Help' }), 'title'), 'Acme Help')
  assert.equal(value(pageHead({ ...site, path: '/', home: true, title: 'Acme Help Center: answers about billing' }), 'title'), 'Acme Help Center: answers about billing')
})

test('without APP_URL nothing absolute is guessed', () => {
  const head = pageHead({ ...site, siteUrl: null, path: '/articles', title: 'Articles', breadcrumbs: [{ name: 'Home', path: '/' }] })
  assert.deepEqual(head.links, [])
  assert.equal(metaOf(head, 'og:url'), undefined)
  assert.deepEqual(head.scripts, [])
})

test('noindex pages have no canonical or structured data, and links are still followed', () => {
  const head = pageHead({ ...site, path: '/articles', title: 'Search: refunds', noindex: true, breadcrumbs: [{ name: 'Home', path: '/' }] })
  assert.equal(value(head, 'robots'), 'noindex, follow')
  assert.deepEqual(head.links, [])
  assert.deepEqual(head.scripts, [])
})

test('an empty description is left out, not sent blank', () => {
  const head = pageHead({ ...site, path: '/articles/x', title: 'X', description: '  ' })
  assert.equal(metaOf(head, 'description'), undefined)
  assert.equal(metaOf(head, 'og:description'), undefined)
})

test('articles carry Article data and a breadcrumb trail ending at the page', () => {
  const head = pageHead({
    ...site,
    path: '/articles/billing/refunds',
    title: 'Refunds',
    description: 'How refunds work',
    type: 'article',
    modifiedAt: '2026-10-29T10:00:00.000Z',
    section: 'Billing',
    breadcrumbs: [
      { name: 'Home', path: '/' },
      { name: 'Articles', path: '/articles' },
      { name: 'Billing', path: '/articles/billing' },
    ],
    structured: [articleData(site.siteUrl, { title: 'Refunds', description: 'How refunds work', path: '/articles/billing/refunds', modifiedAt: '2026-10-29T10:00:00.000Z', brandName: 'Acme Help', section: 'Billing' })],
  })
  assert.equal(value(head, 'og:type'), 'article')
  assert.equal(value(head, 'article:modified_time'), '2026-10-29T10:00:00.000Z')
  assert.equal(value(head, 'article:section'), 'Billing')
  const [crumbs, article] = head.scripts.map((s) => {
    assert.equal(s.type, 'application/ld+json')
    return JSON.parse(s.children) as Record<string, any>
  })
  assert.equal(crumbs!['@context'], 'https://schema.org')
  assert.deepEqual(
    crumbs!.itemListElement.map((i: any) => [i.position, i.name, i.item]),
    [
      [1, 'Home', 'https://help.acme.test/'],
      [2, 'Articles', 'https://help.acme.test/articles'],
      [3, 'Billing', 'https://help.acme.test/articles/billing'],
      [4, 'Refunds', 'https://help.acme.test/articles/billing/refunds'],
    ],
  )
  assert.equal(article!['@type'], 'Article')
  assert.equal(article!.headline, 'Refunds')
  assert.equal(article!.dateModified, '2026-10-29T10:00:00.000Z')
  assert.equal(article!.mainEntityOfPage['@id'], 'https://help.acme.test/articles/billing/refunds')
  assert.equal(article!.publisher.name, 'Acme Help')
})

test('the home page offers the site search to search engines', () => {
  const data = websiteData(site.siteUrl, site.brandName)
  assert.equal(data.potentialAction.target.urlTemplate, 'https://help.acme.test/articles?q={search_term_string}')
})

test('structured data can’t close its <script> tag', () => {
  const out = jsonLd({ headline: '</script><script>alert(1)</script> & co' })
  assert.doesNotMatch(out, /<|>|&/)
  assert.doesNotMatch(jsonLd({ text: 'a\u2028b\u2029c' }), /[\u2028\u2029]/)
  assert.equal(JSON.parse(out).headline, '</script><script>alert(1)</script> & co')
})

test('the sitemap lists each section and subsection once, dated by its newest article', () => {
  const entries = sectionEntries([
    { path: 'billing/plans', modifiedAt: '2026-10-01T00:00:00.000Z' },
    { path: 'billing/invoices/refunds', modifiedAt: '2026-10-20T00:00:00.000Z' },
    { path: 'billing/invoices/vat', modifiedAt: '2026-10-05T00:00:00.000Z' },
    { path: 'welcome', modifiedAt: '2026-10-30T00:00:00.000Z' },
  ])
  assert.deepEqual(entries, [
    { path: 'billing', modifiedAt: '2026-10-20T00:00:00.000Z' },
    { path: 'billing/invoices', modifiedAt: '2026-10-20T00:00:00.000Z' },
  ])
})

test('pages read the brand and APP_URL from the root route', () => {
  assert.deepEqual(siteFrom([{ routeId: '__root__', loaderData: { brandName: 'Acme Help', siteUrl: 'https://help.acme.test' } }, { routeId: '/' }]), {
    ...site,
    homeTitle: null,
    description: null,
  })
  assert.deepEqual(siteFrom([]), { brandName: 'Help Center', siteUrl: null, homeTitle: null, description: null })
  const seo = { homeTitle: 'Acme Help Center', description: 'Answers about Acme.' }
  assert.deepEqual(siteFrom([{ routeId: '__root__', loaderData: { ...site, seo } }]), { ...site, ...seo })
})

test('pages without a description get one from their content', () => {
  assert.equal(excerpt('## Setup\n\nOpen **Settings** and [invite](/x) people.'), 'Setup Open Settings and invite people.')
  const long = excerpt('word '.repeat(80))
  assert.ok(long.length <= 160, String(long.length))
  assert.match(long, /word…$/)
  assert.equal(sectionDescription('Billing', ['Plans', 'Invoices']), 'Help articles on Billing: Plans, Invoices.')
  assert.equal(sectionDescription('Billing', ['A', 'B', 'C', 'D', 'E']), 'Help articles on Billing: A, B, C, D and more.')
  // A short summary is followed by the page's own text, up to about 160 characters.
  assert.equal(fullDescription('Plans and invoices', 'Every plan is billed monthly.'), 'Plans and invoices. Every plan is billed monthly.')
  assert.equal(fullDescription('', 'Opening text.'), 'Opening text.')
  const enough = 'A summary that is already long enough to fill most of a search result line on its own, so nothing else is added to it.'
  assert.equal(fullDescription(enough, 'More text.'), enough)
  assert.ok(fullDescription('Short.', 'word '.repeat(60)).length <= 160)
  assert.equal(sectionDescription('Billing', []), 'Help articles on Billing.')
  assert.equal(articlesDescription('Acme', ['Billing', 'Teams']), 'Browse Acme articles by section: Billing, Teams. Search for answers to common questions, or ask the assistant.')
})

test('article dates read the same everywhere', async () => {
  const { articleDate } = await import('../src/lib/article-date.ts')
  assert.equal(articleDate('2026-10-29T23:30:00.000Z'), 'Oct 29, 2026')
  assert.equal(articleDate('2026-10-29T23:30:00.000Z', 'long'), 'October 29, 2026')
  assert.equal(articleDate('not a date'), '')
})
