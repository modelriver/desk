import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { canBeDraft, isDraft, serializeArticle, statusOf, withStatus } from '../src/lib/article-file.ts'
import { buildContextMessage } from '../src/lib/prompt-core.ts'

// The fs- and DB-backed modules read DATA_DIR and DATABASE_PATH when first
// imported, so point them at throwaway places before loading them.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-drafts-'))
const dataDir = path.join(tmp, 'data')
process.env.DATA_DIR = dataDir
process.env.DATABASE_PATH = path.join(tmp, 'desk.db')
const tree = await import('../src/server/tree.server.ts')
after(() => fs.rmSync(tmp, { recursive: true, force: true }))
const content = await import('../src/server/content.server.ts')

const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dataDir, rel)), { recursive: true })
  fs.writeFileSync(path.join(dataDir, rel), text)
}
const read = (rel: string) => fs.readFileSync(path.join(dataDir, rel), 'utf8')

beforeEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
  fs.mkdirSync(path.join(dataDir, 'public'), { recursive: true })
  fs.mkdirSync(path.join(dataDir, 'private'), { recursive: true })
})

// --- The rule, in front matter ---

test('status: draft (or draft: true) makes a draft; anything else is published', () => {
  assert.equal(statusOf({ status: 'draft' }), 'draft')
  assert.equal(statusOf({ status: 'Draft' }), 'draft')
  assert.equal(statusOf({ draft: 'true' }), 'draft')
  assert.equal(statusOf({ draft: 'yes' }), 'draft')
  assert.equal(statusOf({}), 'published')
  assert.equal(statusOf({ status: 'published' }), 'published')
  assert.equal(statusOf({ draft: 'false' }), 'published')
  assert.equal(isDraft('---\ntitle: A\nstatus: draft\n---\nBody', 'a.md'), true)
  assert.equal(isDraft('---\ntitle: A\n---\nBody', 'a.md'), false)
  // Plain-text notes have no front matter, so they're never drafts.
  assert.equal(isDraft('status: draft', 'notes.txt'), false)
  assert.equal(canBeDraft('notes.txt'), false)
  assert.equal(canBeDraft('refunds.md'), true)
})

test('changing the status touches nothing else in the file', () => {
  const source = '---\ntitle: Refunds\ndescription: "How refunds work: the rules"\ncategory: Billing\n---\n\n# Refunds\n\nWithin 14 days.\n'
  const draft = withStatus(source, 'draft')
  assert.equal(draft, '---\ntitle: Refunds\ndescription: "How refunds work: the rules"\ncategory: Billing\nstatus: draft\n---\n\n# Refunds\n\nWithin 14 days.\n')
  assert.equal(withStatus(draft, 'published'), source)
  // Already that status: unchanged.
  assert.equal(withStatus(source, 'published'), source)
  assert.equal(withStatus(draft, 'draft'), draft)
  // The other spelling is replaced, not doubled.
  assert.equal(withStatus('---\ntitle: A\ndraft: true\n---\nBody', 'published'), '---\ntitle: A\n---\nBody')
  assert.equal(withStatus('---\ntitle: A\ndraft: true\n---\nBody', 'draft'), '---\ntitle: A\nstatus: draft\n---\nBody')
})

test('a file without front matter gets some only to become a draft', () => {
  assert.equal(withStatus('# Hello\n', 'draft'), '---\nstatus: draft\n---\n\n# Hello\n')
  assert.equal(withStatus('# Hello\n', 'published'), '# Hello\n')
  // Publishing removes front matter that only held the status.
  assert.equal(withStatus('---\nstatus: draft\n---\n\n# Hello\n', 'published'), '# Hello\n')
})

test('saving from the editor sets the status, or keeps the one the file had', () => {
  const fields = { title: 'Refunds', description: '', body: 'Within 14 days.' }
  assert.match(serializeArticle(fields, null, 'draft'), /\nstatus: draft\n/)
  assert.doesNotMatch(serializeArticle(fields, null, 'published'), /status/)
  const draft = serializeArticle(fields, null, 'draft')
  assert.match(serializeArticle(fields, draft), /\nstatus: draft\n/, 'no status given: stays a draft')
  assert.doesNotMatch(serializeArticle(fields, draft, 'published'), /status/)
})

// --- Saving, Publish and Unpublish on disk ---

test('a new article can be saved as a draft, then published, then unpublished', () => {
  const saved = tree.saveArticle({
    visibility: 'public',
    folder: '',
    path: null,
    baseModifiedAt: null,
    fields: { title: 'Gift cards', description: 'Buying and using them', body: 'Coming soon.' },
    status: 'draft',
  })
  assert.equal(saved.path, 'gift-cards.md')
  assert.match(read('public/gift-cards.md'), /\nstatus: draft\n/)
  assert.equal(tree.readArticle('public', 'gift-cards.md').status, 'draft')
  const node = tree.readTree('public').children.find((c) => c.name === 'gift-cards.md')
  assert.ok(node?.kind === 'file' && node.draft, 'the Data page shows it as a draft')

  tree.setArticleStatus('public', 'gift-cards.md', 'published')
  assert.doesNotMatch(read('public/gift-cards.md'), /status/)
  assert.equal(tree.readArticle('public', 'gift-cards.md').status, 'published')
  assert.match(read('public/gift-cards.md'), /title: Gift cards\ndescription: Buying and using them\n/)

  tree.setArticleStatus('public', 'gift-cards.md', 'draft')
  assert.equal(tree.readArticle('public', 'gift-cards.md').status, 'draft')
})

test('saving an existing article without a status keeps it a draft', () => {
  write('public/refunds.md', '---\ntitle: Refunds\nstatus: draft\n---\n\nOld.\n')
  const base = fs.statSync(path.join(dataDir, 'public/refunds.md')).mtime.toISOString()
  tree.saveArticle({ visibility: 'public', folder: '', path: 'refunds.md', baseModifiedAt: base, fields: { title: 'Refunds', description: '', body: 'New.' } })
  assert.match(read('public/refunds.md'), /\nstatus: draft\n[\s\S]*New\./)
})

test('plain-text notes can’t be drafts', () => {
  write('private/playbook.txt', 'Escalate refunds over $100.')
  assert.throws(() => tree.setArticleStatus('private', 'playbook.txt', 'draft'), /Plain-text notes can’t be drafts/)
  assert.throws(
    () => tree.saveArticle({ visibility: 'private', folder: '', path: 'playbook.txt', baseModifiedAt: null, fields: { title: 'x', description: '', body: 'y' }, status: 'draft' }),
    /Plain-text notes can’t be drafts/,
  )
  assert.equal(read('private/playbook.txt'), 'Escalate refunds over $100.')
})

test('moving a draft between folders keeps it a draft', () => {
  write('public/refunds.md', '---\ntitle: Refunds\nstatus: draft\n---\n\nBody.\n')
  const folder = tree.createFolder('public', '', 'Billing')
  tree.moveItem({ visibility: 'public', path: 'refunds.md', kind: 'file' }, { visibility: 'public', folder, before: null })
  assert.equal(tree.readArticle('public', `${folder}/refunds.md`).status, 'draft')
})

// --- Drafts never reach the help center or the AI ---

function seed() {
  write('public/exporting.md', '---\ntitle: Exporting your data\n---\n\nExport notebooks as Markdown or PDF from the menu.\n')
  write('public/gift-cards.md', '---\ntitle: Gift cards\nstatus: draft\n---\n\nGift cards zebracode never expire.\n')
  write('private/refund-rules.md', '---\ntitle: Refund rules\nstatus: draft\n---\n\nSecret refund threshold quokkanumber is 250.\n')
  write('private/playbook.md', '---\ntitle: Playbook\n---\n\nEscalate billing disputes to Sam.\n')
  content.reloadContent()
}

test('drafts are left out of the help center, its search and the sitemap list', () => {
  seed()
  assert.deepEqual(content.listArticles().map((a) => a.slug), ['exporting'])
  assert.equal(content.getArticle('gift-cards'), null)
  assert.ok(content.getArticle('exporting'))
  assert.deepEqual(content.searchHelp('zebracode'), [])
  assert.ok(content.searchHelp('export').length > 0)
})

test('nothing from a draft is sent to the AI, public or private', () => {
  seed()
  assert.deepEqual(content.searchContent('zebracode gift cards'), [])
  assert.deepEqual(content.searchContent('quokkanumber refund threshold'), [])
  // Published notes are still used.
  assert.ok(content.searchContent('escalate billing disputes').some((c) => c.slug === 'playbook'))
  const { content: context } = buildContextMessage(content.searchContent('gift cards refund threshold export', 6))
  assert.ok(!context.includes('zebracode'))
  assert.ok(!context.includes('quokkanumber'))
})

test('publishing a draft puts it in the help center and the AI’s context; unpublishing takes it out again', () => {
  seed()
  tree.setArticleStatus('public', 'gift-cards.md', 'published')
  content.reloadContent()
  assert.ok(content.listArticles().some((a) => a.slug === 'gift-cards'))
  assert.ok(content.searchContent('zebracode').length > 0)

  tree.setArticleStatus('public', 'gift-cards.md', 'draft')
  content.reloadContent()
  assert.ok(!content.listArticles().some((a) => a.slug === 'gift-cards'))
  assert.deepEqual(content.searchContent('zebracode'), [])
})

test('a draft still reserves its address, so publishing it later can’t clash', () => {
  write('public/gift-cards.md', '---\ntitle: Gift cards\nstatus: draft\n---\n\nSoon.\n')
  const saved = tree.saveArticle({ visibility: 'public', folder: '', path: null, baseModifiedAt: null, fields: { title: 'Gift cards', description: '', body: 'Other.' }, status: 'published' })
  assert.equal(saved.path, 'gift-cards-2.md')
})
