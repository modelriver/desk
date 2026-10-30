import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// The fs-backed functions read DATA_DIR when first imported, so point it at a
// throwaway folder before loading them.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-folder-upload-'))
process.env.DATA_DIR = dataDir
const tree = await import('../src/server/tree.server.ts')
const { planFolderUpload } = await import('../src/lib/folder-upload.ts')

const read = (rel: string) => fs.readFileSync(path.join(dataDir, rel), 'utf8')
const meta = (rel: string) => JSON.parse(read(path.join(rel, '.desk.json'))) as { title?: string; order?: string[] }
const names = (folder: { children: Array<{ name: string }> }) => folder.children.map((c) => c.name)
// New Markdown uploads are saved as drafts: this front matter goes on top.
const DRAFT = '---\nstatus: draft\n---\n\n'

before(() => {
  fs.mkdirSync(path.join(dataDir, 'public'), { recursive: true })
  fs.mkdirSync(path.join(dataDir, 'private'), { recursive: true })
})
after(() => fs.rmSync(dataDir, { recursive: true, force: true }))

test('a batch creates nested folders with their titles, in order, and writes every file', () => {
  const written = tree.writeUploadBatch(
    'public',
    [
      { path: 'getting-started/quick-start.md', text: '# Quick start' },
      { path: 'getting-started/api-keys/rotating.md', text: '# Rotating keys' },
      { path: 'getting-started/api-keys/scopes.md', text: '# Scopes' },
    ],
    { 'getting-started': 'Getting Started', 'getting-started/api-keys': 'API keys' },
  )
  assert.deepEqual(written.map((w) => w.draft), [true, true, true], 'new uploads are drafts')
  assert.equal(read('public/getting-started/api-keys/scopes.md'), DRAFT + '# Scopes')
  assert.equal(meta('public/getting-started').title, 'Getting Started')
  assert.equal(meta('public/getting-started/api-keys').title, 'API keys')
  // New folders come before new files, as on the Data page before anyone arranges it.
  assert.deepEqual(meta('public/getting-started').order, ['api-keys', 'quick-start.md'])
  assert.deepEqual(meta('public/getting-started/api-keys').order, ['rotating.md', 'scopes.md'])
  assert.deepEqual(names(tree.readTree('public')), ['getting-started'])
})

test('a later batch merges into existing folders and keeps their titles', () => {
  tree.writeUploadBatch('public', [{ path: 'getting-started/faq.md', text: '# FAQ' }], { 'getting-started': 'Renamed by mistake' })
  assert.equal(meta('public/getting-started').title, 'Getting Started')
  assert.deepEqual(meta('public/getting-started').order, ['api-keys', 'quick-start.md', 'faq.md'])
})

test('uploading over an article replaces it in place, by folder upload and by single upload', () => {
  tree.writeUploadBatch('public', [{ path: 'getting-started/faq.md', text: '# FAQ v2' }], {})
  assert.equal(read('public/getting-started/faq.md'), DRAFT + '# FAQ v2')
  // Used to be refused as a clash with a folder of the same name.
  tree.writeUpload('public', 'getting-started', 'faq.md', '# FAQ v3')
  assert.equal(read('public/getting-started/faq.md'), DRAFT + '# FAQ v3')
  assert.deepEqual(meta('public/getting-started').order, ['api-keys', 'quick-start.md', 'faq.md'], 'not listed twice')
})

test('new uploads are drafts, whatever their own front matter says; replacing a published article keeps it live', () => {
  // A new file that claims to be published is still saved as a draft, with its other front matter kept.
  const [single] = [tree.writeUpload('public', 'getting-started', 'Billing basics.md', '---\ntitle: Billing basics\nstatus: published\n---\n\n# Body')]
  assert.equal(read(`public/${single}`), '---\ntitle: Billing basics\nstatus: draft\n---\n\n# Body')

  // Publish it, then upload over it: it stays published, with the new content.
  tree.setArticleStatus('public', 'getting-started/billing-basics.md', 'published')
  const [replaced] = tree.writeUploadBatch('public', [{ path: 'getting-started/billing-basics.md', text: '---\ntitle: Billing basics\n---\n\n# New body' }], {})
  assert.deepEqual(replaced, { path: 'getting-started/billing-basics.md', draft: false })
  assert.equal(read('public/getting-started/billing-basics.md'), '---\ntitle: Billing basics\n---\n\n# New body')
  // Even when the new content says it's a draft: the article's status is what's kept.
  tree.writeUpload('public', 'getting-started', 'billing-basics.md', '---\nstatus: draft\n---\n# Newer')
  assert.equal(read('public/getting-started/billing-basics.md'), '# Newer')

  // A draft replaced stays a draft.
  tree.writeUpload('public', 'getting-started', 'faq.md', '# FAQ v4')
  assert.equal(read('public/getting-started/faq.md'), DRAFT + '# FAQ v4')
})

test('a batch with any problem writes nothing', () => {
  const before = JSON.stringify(tree.readTree('public'))
  // Second file reuses a public article name from another folder.
  assert.throws(
    () =>
      tree.writeUploadBatch(
        'public',
        [
          { path: 'guides/new.md', text: '# New' },
          { path: 'guides/scopes.md', text: '# Scopes again' },
        ],
        { guides: 'Guides' },
      ),
    /already exists at getting-started\/api-keys\/scopes.md/,
  )
  assert.throws(() => tree.writeUploadBatch('public', [{ path: 'guides/x.md', text: 'a\u0000b' }], {}), /text file/)
  assert.throws(() => tree.writeUploadBatch('public', [{ path: 'guides/x.txt', text: 'notes' }], {}), /isn’t a file type allowed/)
  assert.throws(() => tree.writeUploadBatch('public', [{ path: 'a/b/c/x.md', text: 'x' }], {}), /levels deep/)
  assert.throws(() => tree.writeUploadBatch('public', [{ path: '../escape.md', text: 'x' }], {}), /Invalid/)
  assert.throws(() => tree.writeUploadBatch('public', [{ path: 'guides/big.md', text: 'x'.repeat(tree.MAX_FILE_BYTES + 1) }], {}), /over 1 MB/)
  assert.throws(
    () =>
      tree.writeUploadBatch(
        'public',
        [
          { path: 'guides/x.md', text: '1' },
          { path: 'guides/x.md', text: '2' },
        ],
        {},
      ),
    /twice/,
  )
  assert.equal(JSON.stringify(tree.readTree('public')), before)
  assert.ok(!fs.existsSync(path.join(dataDir, 'public/guides')), 'no folder left behind')
})

test('a folder and an article never end up sharing a web address', () => {
  tree.writeUploadBatch('public', [{ path: 'setup.md', text: '# Setup' }], {})
  // A new folder "setup" beside the article setup.md.
  assert.throws(() => tree.writeUploadBatch('public', [{ path: 'setup/linux.md', text: '# Linux' }], {}), /share a web address/)
  // A new article "getting-started" beside the folder.
  assert.throws(() => tree.writeUploadBatch('public', [{ path: 'getting-started.md', text: '# GS' }], {}), /share a web address/)
  // Both in one batch.
  assert.throws(
    () =>
      tree.writeUploadBatch(
        'public',
        [
          { path: 'deploy.md', text: '# Deploy' },
          { path: 'deploy/fly.md', text: '# Fly' },
        ],
        {},
      ),
    /share a web address/,
  )
})

test('private notes: .txt allowed, names may repeat across folders', () => {
  tree.writeUploadBatch(
    'private',
    [
      { path: 'team/escalation.txt', text: 'Call Sam' },
      { path: 'team/notes.md', text: '# A' },
      { path: 'sales/notes.md', text: '# B' },
    ],
    { team: 'Team', sales: 'Sales' },
  )
  assert.equal(read('private/team/escalation.txt'), 'Call Sam')
  assert.deepEqual(names(tree.readTree('private')), ['sales', 'team'])
})

test('the plan from the live tree and the writer agree, end to end', () => {
  const entries = [
    { path: 'Billing/Plans.md', size: 7 },
    { path: 'Billing/Invoices/Refund policy.md', size: 9 },
    { path: 'Billing/.DS_Store', size: 4 },
  ]
  const result = planFolderUpload({ visibility: 'public', target: '', entries, tree: tree.readTree('public'), allowed: ['.md'], maxBytes: tree.MAX_FILE_BYTES })
  if (!result.ok) return assert.fail(result.problems.join(' '))
  const titles = Object.fromEntries(result.plan.folders.map((f) => [f.path, f.title]))
  tree.writeUploadBatch(
    'public',
    result.plan.files.map((f) => ({ path: f.path, text: `# ${f.source}` })),
    titles,
  )
  assert.equal(read('public/billing/invoices/refund-policy.md'), DRAFT + '# Billing/Invoices/Refund policy.md')
  assert.equal(meta('public/billing').title, 'Billing')
  assert.equal(meta('public/billing/invoices').title, 'Invoices')
  assert.deepEqual(result.plan.skipped, [{ source: 'Billing/.DS_Store', reason: 'hidden' }])

  // The same upload again is all replacements.
  const again = planFolderUpload({ visibility: 'public', target: '', entries, tree: tree.readTree('public'), allowed: ['.md'], maxBytes: tree.MAX_FILE_BYTES })
  assert.ok(again.ok && again.plan.files.every((f) => f.replaces) && again.plan.folders.length === 0)
})

test('publishing and unpublishing many files at once', () => {
  const items = [
    { visibility: 'public' as const, path: 'getting-started/quick-start.md' },
    { visibility: 'public' as const, path: 'getting-started/api-keys/scopes.md' },
    { visibility: 'public' as const, path: 'getting-started/billing-basics.md' },
  ]
  // billing-basics.md is already published: only the two drafts change.
  assert.equal(tree.setArticleStatuses(items, 'published'), 2)
  assert.equal(read('public/getting-started/api-keys/scopes.md'), '# Scopes')
  const statuses = () => items.map((i) => tree.readArticle(i.visibility, i.path).status)
  assert.deepEqual(statuses(), ['published', 'published', 'published'])

  assert.equal(tree.setArticleStatuses(items, 'draft'), 3)
  assert.deepEqual(statuses(), ['draft', 'draft', 'draft'])
  assert.equal(tree.setArticleStatuses(items, 'draft'), 0, 'already drafts: nothing to change')
})

test('a bulk change with any file that’s gone or can’t be a draft changes nothing', () => {
  const before = read('public/getting-started/quick-start.md')
  assert.throws(
    () =>
      tree.setArticleStatuses(
        [
          { visibility: 'public', path: 'getting-started/quick-start.md' },
          { visibility: 'public', path: 'getting-started/gone.md' },
        ],
        'published',
      ),
    /no longer exists/,
  )
  tree.writeUploadBatch('private', [{ path: 'ops/runbook.txt', text: 'Restart it' }], {})
  assert.throws(
    () =>
      tree.setArticleStatuses(
        [
          { visibility: 'public', path: 'getting-started/quick-start.md' },
          { visibility: 'private', path: 'ops/runbook.txt' },
        ],
        'published',
      ),
    /can’t be drafts/,
  )
  assert.throws(() => tree.setArticleStatuses([{ visibility: 'public', path: '../escape.md' }], 'published'), /Invalid/)
  assert.equal(read('public/getting-started/quick-start.md'), before)
})
