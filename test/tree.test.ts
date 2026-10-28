import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { orderChildren, parsePath, placeInOrder, folderName } from '../src/lib/tree-core.ts'
import { articleBodyForEditor, hasLeadingH1, serializeArticle } from '../src/lib/article-file.ts'

// The fs-backed functions read DATA_DIR when first imported, so point it at a
// throwaway folder before loading them.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-tree-'))
process.env.DATA_DIR = dataDir
const tree = await import('../src/server/tree.server.ts')

const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dataDir, rel)), { recursive: true })
  fs.writeFileSync(path.join(dataDir, rel), text)
}
const names = (folder: { children: Array<{ name: string }> }) => folder.children.map((c) => c.name)

before(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
  fs.mkdirSync(path.join(dataDir, 'public'), { recursive: true })
  fs.mkdirSync(path.join(dataDir, 'private'), { recursive: true })
})

test('paths: plain names only, never outside the folder, at most two folders deep', () => {
  assert.deepEqual(parsePath('billing/invoices/refunds.md', 'file'), ['billing', 'invoices', 'refunds.md'])
  assert.deepEqual(parsePath('', 'folder'), [])
  for (const bad of ['../secret.md', '/etc/passwd.md', 'a/../../x.md', '.desk.json', 'Billing/x.md', 'a/b/c/x.md', 'x.exe', 'a//x.md']) {
    assert.throws(() => parsePath(bad, 'file'), Error, bad)
  }
  assert.throws(() => parsePath('a/b/c', 'folder'))
  assert.equal(folderName('Billing & Invoices!'), 'billing-invoices')
})

test('ordering: listed names first, the rest folders-first by name; moves place before a sibling', () => {
  const items = [
    { name: 'b.md', folder: false },
    { name: 'a.md', folder: false },
    { name: 'zeta', folder: true },
  ]
  assert.deepEqual(orderChildren(items, ['b.md', 'gone.md']), ['b.md', 'zeta', 'a.md'])
  assert.deepEqual(placeInOrder(['a', 'b', 'c'], 'c', 'a'), ['c', 'a', 'b'])
  assert.deepEqual(placeInOrder(['a', 'b', 'c'], 'a', null), ['b', 'c', 'a'])
  assert.deepEqual(placeInOrder(['a', 'b'], 'new', 'b'), ['a', 'new', 'b'])
})

test('an unarranged top level keeps the old front-matter order', () => {
  write('public/late.md', '---\ntitle: Late\norder: 50\n---\nx')
  write('public/early.md', '---\ntitle: Early\norder: 10\n---\nx')
  assert.deepEqual(names(tree.readTree('public')), ['early.md', 'late.md'])
})

test('folders: created with a clean unique name and a title, listed where they were added', () => {
  const a = tree.createFolder('public', '', 'Billing & plans')
  const b = tree.createFolder('public', '', 'Billing & plans')
  assert.equal(a, 'billing-plans')
  assert.equal(b, 'billing-plans-2')
  const sub = tree.createFolder('public', a, 'Invoices')
  assert.equal(sub, 'billing-plans/invoices')
  assert.throws(() => tree.createFolder('public', sub, 'Too deep'), /2 levels/)
  const root = tree.readTree('public')
  assert.deepEqual(names(root).slice(-2), ['billing-plans', 'billing-plans-2'])
  // A new title with the same URL name keeps the folder where it is.
  assert.equal(tree.renameFolder('public', a, 'Billing & Plans'), a)
  assert.equal((tree.readTree('public').children.find((c) => c.name === a) as { title: string }).title, 'Billing & Plans')
  // A different name moves it on disk (its URL follows), in the same place.
  const before = names(tree.readTree('public'))
  assert.equal(tree.renameFolder('public', b, 'Pricing'), 'pricing')
  assert.deepEqual(names(tree.readTree('public')), before.map((n) => (n === b ? 'pricing' : n)))
  // Taken names get a number.
  assert.equal(tree.renameFolder('public', 'pricing', 'Billing plans'), 'billing-plans-2')
  tree.deleteItem('public', 'billing-plans-2', 'folder')
})

test('moving files: into folders, reordering, and refusing what would break the help center', () => {
  tree.moveItem({ visibility: 'public', path: 'late.md', kind: 'file' }, { visibility: 'public', folder: 'billing-plans', before: null })
  tree.moveItem({ visibility: 'public', path: 'early.md', kind: 'file' }, { visibility: 'public', folder: 'billing-plans', before: 'late.md' })
  const billing = tree.readTree('public', 'billing-plans')
  assert.deepEqual(names(billing), ['invoices', 'early.md', 'late.md'].filter((n) => names(billing).includes(n)))
  assert.ok(names(billing).indexOf('early.md') < names(billing).indexOf('late.md'))

  // Reorder within the folder.
  tree.moveItem({ visibility: 'public', path: 'billing-plans/late.md', kind: 'file' }, { visibility: 'public', folder: 'billing-plans', before: 'early.md' })
  const order = names(tree.readTree('public', 'billing-plans'))
  assert.ok(order.indexOf('late.md') < order.indexOf('early.md'))

  // Text notes can't become public articles; a public name must stay unique.
  write('private/notes.txt', 'internal')
  assert.throws(
    () => tree.moveItem({ visibility: 'private', path: 'notes.txt', kind: 'file' }, { visibility: 'public', folder: '', before: null }),
    /Markdown/,
  )
  write('private/early.md', '# Early copy')
  assert.throws(
    () => tree.moveItem({ visibility: 'private', path: 'early.md', kind: 'file' }, { visibility: 'public', folder: '', before: null }),
    /already exists/,
  )
})

test('moving folders: never into themselves, never deeper than two levels', () => {
  const top = tree.createFolder('public', '', 'Guides')
  assert.throws(
    () => tree.moveItem({ visibility: 'public', path: 'billing-plans', kind: 'folder' }, { visibility: 'public', folder: 'billing-plans/invoices', before: null }),
    /inside itself/,
  )
  // billing-plans has a subfolder, so it can't become a subfolder itself.
  assert.throws(
    () => tree.moveItem({ visibility: 'public', path: 'billing-plans', kind: 'folder' }, { visibility: 'public', folder: top, before: null }),
    /levels deep/,
  )
  const moved = tree.moveItem({ visibility: 'public', path: top, kind: 'folder' }, { visibility: 'public', folder: 'billing-plans', before: null })
  assert.equal(moved, 'billing-plans/guides')
})

test('uploads land in the chosen folder; a public name used elsewhere is refused', () => {
  const rel = tree.writeUpload('public', 'billing-plans/invoices', 'Refund Policy.MD', '# Refunds')
  assert.equal(rel, 'billing-plans/invoices/refund-policy.md')
  assert.throws(() => tree.writeUpload('public', '', 'refund-policy.md', '# Again'), /already exists/)
  assert.throws(() => tree.writeUpload('public', '', 'x.md', 'a\u0000b'), /text file/)
})

test('symlinks in the data folder are refused', () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-outside-'))
  const link = path.join(dataDir, 'public', 'linked')
  try {
    fs.writeFileSync(path.join(outside, 'secret.md'), 'secret')
    fs.symlinkSync(outside, link)
    assert.throws(() => tree.readFile('public', 'linked/secret.md'), /Links/)
    assert.ok(!names(tree.readTree('public')).includes('linked'), 'not listed either')
  } finally {
    fs.rmSync(link, { force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  }
})

after(() => fs.rmSync(dataDir, { recursive: true, force: true }))

test('saving: new articles get a free name; edits keep other settings; stale edits are refused', () => {
  const created = tree.saveArticle({
    visibility: 'public',
    folder: 'billing-plans',
    path: null,
    baseModifiedAt: null,
    fields: { title: 'Refund policy', description: 'How refunds work', body: 'Body text' },
  })
  assert.equal(created.path, 'billing-plans/refund-policy-2.md', 'refund-policy is taken in another folder')

  write('public/billing-plans/kept.md', '---\ntitle: Kept\ncategory: Old\norder: 5\n---\n\n# Kept\n\nHello')
  const opened = tree.readArticle('public', 'billing-plans/kept.md')
  assert.equal(opened.title, 'Kept')
  assert.equal(opened.body, 'Hello', 'the title heading is edited in the title field, not the body')
  const saved = tree.saveArticle({
    visibility: 'public',
    folder: 'billing-plans',
    path: 'billing-plans/kept.md',
    baseModifiedAt: opened.modifiedAt,
    fields: { title: 'Kept: updated', description: '', body: 'Hello again' },
  })
  const text = fs.readFileSync(path.join(dataDir, 'public/billing-plans/kept.md'), 'utf8')
  assert.match(text, /^---\ntitle: "Kept: updated"\ncategory: Old\norder: 5\n---\n\nHello again\n$/)

  assert.throws(
    () =>
      tree.saveArticle({
        visibility: 'public',
        folder: 'billing-plans',
        path: 'billing-plans/kept.md',
        baseModifiedAt: '2000-01-01T00:00:00.000Z',
        fields: { title: 'Lost', description: '', body: 'x' },
      }),
    tree.SaveConflict,
  )
  assert.ok(saved.modifiedAt)
})

test('deleting a folder removes what’s inside and says how much', () => {
  const folder = tree.createFolder('private', '', 'Playbooks')
  write('private/playbooks/a.md', 'a')
  write('private/playbooks/b.txt', 'b')
  assert.equal(tree.deleteItem('private', folder, 'folder'), 2)
  assert.ok(!fs.existsSync(path.join(dataDir, 'private/playbooks')))
})

test('article files: title heading split off for editing, other headings kept', () => {
  assert.deepEqual(articleBodyForEditor('---\ntitle: Plans\n---\n# Plans\n\n## Free\n', 'plans.md'), {
    title: 'Plans',
    description: '',
    body: '## Free\n',
  })
  const other = articleBodyForEditor('---\ntitle: Plans\n---\n# Pricing overview\n\ntext', 'plans.md')
  assert.match(other.body, /^# Pricing overview/, 'a different heading is content, not the title')
  assert.equal(articleBodyForEditor('# Only heading\n\ntext', 'x.md').title, 'Only heading')
  assert.equal(hasLeadingH1('\n# Title\n'), true)
  assert.equal(hasLeadingH1('Intro\n# Title'), false)
  // Titles read back exactly as typed, including ones that need quoting.
  for (const title of ['A "quoted" title', 'Billing: plans', '#1 tip', ' padded ']) {
    const back = articleBodyForEditor(serializeArticle({ title, description: 'd: x', body: 'x' }, null), 'x.md')
    assert.equal(back.title, title.trim().replace(/"/g, title.match(/[:#]|^\s|\s$/) ? "'" : '"'), title)
    assert.equal(back.description, 'd: x')
  }
})

test('a folder and an article beside it never share a web address', () => {
  write('public/pricing.md', '# Pricing')
  // A new folder steps around the article's name...
  assert.equal(tree.createFolder('public', '', 'Pricing'), 'pricing-2')
  // ...a new article steps around a folder's...
  const folder = tree.createFolder('public', '', 'Guides')
  const saved = tree.saveArticle({ visibility: 'public', folder: '', path: null, baseModifiedAt: null, fields: { title: 'Guides', description: '', body: 'x' } })
  assert.equal(saved.path, 'guides-2.md')
  // ...and moves that would clash are refused.
  write('public/pricing-2/guides.md', '# Inner guides')
  assert.throws(
    () => tree.moveItem({ visibility: 'public', path: 'pricing-2/guides.md', kind: 'file' }, { visibility: 'public', folder: '', before: null }),
    /already a “guides\.md”|share a web address/,
  )
  for (const rel of ['pricing.md', 'guides-2.md']) tree.deleteItem('public', rel, 'file')
  for (const rel of ['pricing-2', folder]) tree.deleteItem('public', rel, 'folder')
})
