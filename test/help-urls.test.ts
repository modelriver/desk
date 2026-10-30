import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ARTICLES_PATH, articleUrl, folderOf, helpPath, resolveHelpPath } from '../src/lib/help-path.ts'
import { groupByCategory, toDoc } from '../src/lib/content-core.ts'

// Help-center URLs carry an article's folders: /articles/billing/refunds.
const articles = [
  { slug: 'intro', path: 'intro' },
  { slug: 'refunds', path: 'billing/refunds' },
  { slug: 'roles', path: 'getting-started/your-team/roles' },
]

test('an article’s URL is its folders, then its name', () => {
  assert.equal(helpPath('billing/refunds.md', 'refunds'), 'billing/refunds')
  assert.equal(helpPath('intro.md', 'intro'), 'intro')
  assert.equal(toDoc('getting-started/your-team/roles.md', '# Roles', 'public').path, 'getting-started/your-team/roles')
  assert.equal(folderOf('getting-started/your-team/roles', 1), 'getting-started')
  assert.equal(folderOf('getting-started/your-team/roles', 2), 'getting-started/your-team')
  assert.equal(folderOf('billing/refunds', 2), null)
  assert.equal(folderOf('intro', 1), null)
})

test('URLs resolve to sections, articles, or a redirect to where an article lives now', () => {
  assert.deepEqual(resolveHelpPath('billing', articles), { kind: 'section', depth: 1 })
  assert.deepEqual(resolveHelpPath('getting-started/your-team', articles), { kind: 'section', depth: 2 })
  assert.deepEqual(resolveHelpPath('billing/refunds', articles), { kind: 'article', slug: 'refunds' })
  assert.deepEqual(resolveHelpPath('intro', articles), { kind: 'article', slug: 'intro' })
  // Links from before folders were in URLs, or from before a move.
  assert.deepEqual(resolveHelpPath('refunds', articles), { kind: 'redirect', path: 'billing/refunds' })
  assert.deepEqual(resolveHelpPath('old-section/roles', articles), { kind: 'redirect', path: 'getting-started/your-team/roles' })
  assert.equal(resolveHelpPath('nope', articles), null)
  assert.equal(resolveHelpPath('billing/nope', articles), null)
  assert.equal(resolveHelpPath('', articles), null)
  // A hand-made clash (folder billing/ beside billing.md): the article still opens.
  assert.deepEqual(resolveHelpPath('billing', [...articles, { slug: 'billing', path: 'billing' }]), { kind: 'article', slug: 'billing' })
})

test('sections and subsections know their own pages', () => {
  const [section] = groupByCategory([
    { slug: 'plans', path: 'billing/plans', title: 'Plans', description: '', category: 'Billing', subcategory: null, order: 10 },
    { slug: 'vat', path: 'billing/invoices/vat', title: 'VAT', description: '', category: 'Billing', subcategory: 'Invoices', order: 20 },
  ])
  assert.equal(section!.path, 'billing')
  assert.equal(section!.subsections[0]!.path, 'billing/invoices')
  const [legacy] = groupByCategory([{ slug: 'a', path: 'a', title: 'A', description: '', category: 'General', subcategory: null, order: 1 }])
  assert.equal(legacy!.path, null)
})

test('the help center lives at /articles', () => {
  assert.equal(ARTICLES_PATH, '/articles')
  assert.equal(articleUrl('billing/refunds'), '/articles/billing/refunds')
  assert.equal(articleUrl(helpPath('billing/refunds.md', 'refunds')), '/articles/billing/refunds')
})
