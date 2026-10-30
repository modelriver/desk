import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseMeta } from '../src/lib/tree-core.ts'
import { COLLECTION_ICONS, ICON_LABELS, isCollectionIcon, searchIcons } from '../src/lib/collection-icons.ts'
import { groupByCategory, withFolderDetails, type ArticleSummary, type FolderDetails } from '../src/lib/content-core.ts'

// The fs-backed functions read DATA_DIR when first imported, so point it at a
// throwaway folder before loading them.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-collections-'))
process.env.DATA_DIR = dataDir
const tree = await import('../src/server/tree.server.ts')

const meta = (rel: string) => JSON.parse(fs.readFileSync(path.join(dataDir, 'public', rel, '.desk.json'), 'utf8')) as Record<string, unknown>

before(() => {
  fs.mkdirSync(path.join(dataDir, 'public'), { recursive: true })
  fs.mkdirSync(path.join(dataDir, 'private'), { recursive: true })
})
after(() => fs.rmSync(dataDir, { recursive: true, force: true }))

test('folder details are read back, cleaned, and unknown icons dropped', () => {
  assert.deepEqual(parseMeta(JSON.stringify({ title: 'Billing', description: '  Plans and invoices  ', icon: 'credit-card', order: ['a.md'] })), {
    title: 'Billing',
    order: ['a.md'],
    description: 'Plans and invoices',
    icon: 'credit-card',
  })
  const odd = parseMeta(JSON.stringify({ description: 'x'.repeat(500), icon: 'not-an-icon' }))
  assert.equal(odd.description?.length, 200)
  assert.equal(odd.icon, undefined)
  assert.equal(parseMeta(JSON.stringify({ description: '   ', icon: 42 })).description, undefined)
})

test('the icon list has no repeats, and every name is accepted', () => {
  assert.equal(new Set(COLLECTION_ICONS).size, COLLECTION_ICONS.length)
  for (const name of COLLECTION_ICONS) assert.ok(isCollectionIcon(name), name)
  assert.ok(!isCollectionIcon('Rocket'))
  assert.ok(!isCollectionIcon(null))
  // Names saved in .desk.json before the list grew still work.
  for (const name of ['book-open', 'rocket', 'credit-card', 'receipt', 'plug', 'headset']) assert.ok(isCollectionIcon(name), name)
  for (const name of COLLECTION_ICONS) assert.ok(ICON_LABELS[name], `${name} has a label`)
})

test('icons are found by name, label or keyword, from the start of a word', () => {
  assert.deepEqual(searchIcons(''), [...COLLECTION_ICONS])
  assert.deepEqual(searchIcons('   '), [...COLLECTION_ICONS])
  // A keyword: "invoice" is a receipt.
  assert.ok(searchIcons('invoice').includes('receipt'))
  // Part of a word, at its start.
  assert.ok(searchIcons('bill').includes('credit-card'))
  assert.ok(!searchIcons('ill').includes('credit-card'), 'not the middle of a word')
  // The label and the name.
  assert.deepEqual(searchIcons('Delivery'), ['truck'])
  assert.ok(searchIcons('shopping').includes('shopping-bag'))
  // Every word must match.
  assert.ok(searchIcons('team').includes('users'))
  assert.ok(!searchIcons('team shipping').includes('users'))
  assert.deepEqual(searchIcons('zzzz'), [])
  // Case and punctuation don't matter.
  assert.deepEqual(searchIcons('API-keys!'), searchIcons('api keys'))
})

test('a folder’s description and icon are saved without touching its title, order or name', () => {
  const rel = tree.createFolder('public', '', 'Billing')
  tree.writeUpload('public', rel, 'plans.md', '# Plans')
  const before = meta(rel)
  tree.setFolderDetails(rel, { description: '  Plans, invoices and refunds ', icon: 'credit-card' })
  assert.deepEqual(meta(rel), { ...before, description: 'Plans, invoices and refunds', icon: 'credit-card' })
  const node = tree.readTree('public').children.find((c) => c.kind === 'folder')!
  assert.equal(node.kind === 'folder' && node.description, 'Plans, invoices and refunds')
  assert.equal(node.kind === 'folder' && node.icon, 'credit-card')
  assert.equal(node.path, 'billing', 'its URL is unchanged')

  // Clearing both removes them.
  tree.setFolderDetails(rel, { description: '', icon: null })
  assert.deepEqual(meta(rel), before)
})

test('details survive everything else that rewrites the folder’s file', () => {
  tree.setFolderDetails('billing', { description: 'Plans and invoices', icon: 'credit-card' })
  // Uploads, moves, renames and new subfolders all rewrite .desk.json.
  tree.writeUploadBatch('public', [{ path: 'billing/refunds.md', text: '# Refunds' }], {})
  tree.moveItem({ visibility: 'public', path: 'billing/refunds.md', kind: 'file' }, { visibility: 'public', folder: 'billing', before: 'plans.md' })
  tree.createFolder('public', 'billing', 'Taxes')
  const renamed = tree.renameFolder('public', 'billing', 'Billing & plans')
  assert.equal(renamed, 'billing-plans')
  const m = meta(renamed)
  assert.equal(m.description, 'Plans and invoices')
  assert.equal(m.icon, 'credit-card')
  assert.equal(m.title, 'Billing & plans')
})

test('bad details are refused and change nothing', () => {
  const before = meta('billing-plans')
  assert.throws(() => tree.setFolderDetails('billing-plans', { description: 'ok', icon: 'not-an-icon' }), /Choose one of the icons/)
  assert.throws(() => tree.setFolderDetails('billing-plans', { description: 'x'.repeat(201), icon: null }), /200 characters/)
  assert.throws(() => tree.setFolderDetails('', { description: 'top', icon: null }), /top level/)
  assert.throws(() => tree.setFolderDetails('gone', { description: 'x', icon: null }), /no longer exists/)
  assert.throws(() => tree.setFolderDetails('../escape', { description: 'x', icon: null }), /Invalid/)
  assert.deepEqual(meta('billing-plans'), before)
})

// --- The help center's cards ---

const article = (path: string, category: string, subcategory: string | null, order: number): ArticleSummary => ({
  slug: path.slice(path.lastIndexOf('/') + 1, -3),
  path: path.replace(/\.md$/, ''),
  title: path,
  description: '',
  category,
  subcategory,
  order,
})

test('sections get their folder’s description and icon, and count their subsections’ articles', () => {
  const articles = [
    article('billing/plans.md', 'Billing', null, 10),
    article('billing/refunds.md', 'Billing', null, 20),
    article('billing/tax/vat.md', 'Billing', 'Tax', 30),
    article('start/intro.md', 'Getting started', null, 40),
    article('faq.md', 'General', null, 1000),
  ]
  const folders = new Map<string, FolderDetails>([
    ['billing', { description: 'Plans and invoices', icon: 'credit-card' }],
    ['billing/tax', { description: 'VAT and sales tax', icon: null }],
    ['start', { description: '', icon: null }],
  ])
  const sections = withFolderDetails(groupByCategory(articles), folders)
  assert.deepEqual(
    sections.map((s) => [s.category, s.path, s.description, s.icon, s.count]),
    [
      ['Billing', 'billing', 'Plans and invoices', 'credit-card', 3],
      ['Getting started', 'start', '', null, 1],
      // Articles outside any folder have no card details.
      ['General', null, '', null, 1],
    ],
  )
  assert.equal(sections[0]!.subsections[0]!.description, 'VAT and sales tax')
})
