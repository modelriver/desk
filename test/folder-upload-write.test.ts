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
  assert.equal(written, 3)
  assert.equal(read('public/getting-started/api-keys/scopes.md'), '# Scopes')
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
  assert.equal(read('public/getting-started/faq.md'), '# FAQ v2')
  // Used to be refused as a clash with a folder of the same name.
  tree.writeUpload('public', 'getting-started', 'faq.md', '# FAQ v3')
  assert.equal(read('public/getting-started/faq.md'), '# FAQ v3')
  assert.deepEqual(meta('public/getting-started').order, ['api-keys', 'quick-start.md', 'faq.md'], 'not listed twice')
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
  assert.equal(read('public/billing/invoices/refund-policy.md'), '# Billing/Invoices/Refund policy.md')
  assert.equal(meta('public/billing').title, 'Billing')
  assert.equal(meta('public/billing/invoices').title, 'Invoices')
  assert.deepEqual(result.plan.skipped, [{ source: 'Billing/.DS_Store', reason: 'hidden' }])

  // The same upload again is all replacements.
  const again = planFolderUpload({ visibility: 'public', target: '', entries, tree: tree.readTree('public'), allowed: ['.md'], maxBytes: tree.MAX_FILE_BYTES })
  assert.ok(again.ok && again.plan.files.every((f) => f.replaces) && again.plan.folders.length === 0)
})
