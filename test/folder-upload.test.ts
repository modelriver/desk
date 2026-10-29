import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeProblems, describeSkipped, foldersFor, MAX_PICKED, packBatches, planFolderUpload, type PlanTree } from '../src/lib/folder-upload.ts'
import { pickedFolder, readDropped } from '../src/lib/dropped-files.ts'

// A tree in the shape the server reads: folders by path, files by path.
const folder = (path: string, children: PlanTree['children'] = []): PlanTree => ({ kind: 'folder', name: path.slice(path.lastIndexOf('/') + 1), path, children })
const file = (path: string) => ({ kind: 'file' as const, name: path.slice(path.lastIndexOf('/') + 1), path })

const publicTree = () => folder('', [folder('billing', [file('billing/plans.md'), folder('billing/invoices', [file('billing/invoices/refunds.md')])]), file('intro.md')])
const MB = 1024 * 1024

function plan(entries: Array<[string, number?]>, opts: { target?: string; visibility?: 'public' | 'private'; tree?: PlanTree } = {}) {
  const visibility = opts.visibility ?? 'public'
  return planFolderUpload({
    visibility,
    target: opts.target ?? '',
    entries: entries.map(([path, size]) => ({ path, size: size ?? 100 })),
    tree: opts.tree ?? (visibility === 'public' ? publicTree() : folder('')),
    allowed: visibility === 'public' ? ['.md'] : ['.md', '.txt'],
    maxBytes: MB,
  })
}

const ok = (result: ReturnType<typeof plan>) => {
  if (!result.ok) assert.fail(`expected a plan, got: ${result.problems.join(' | ')}`)
  return result.plan
}
const problems = (result: ReturnType<typeof plan>) => {
  assert.equal(result.ok, false, 'expected the upload to be refused')
  return result.ok ? [] : result.problems
}

test('keeps the dropped folder’s shape, with clean names and the original titles', () => {
  const p = ok(plan([['Getting Started/Quick Start.md'], ['Getting Started/API keys/Rotating Keys.MD'], ['Guides/getting-help.md']]))
  // Sorted by path, whatever order the browser gave them in.
  assert.deepEqual(
    p.files.map((f) => f.path),
    ['getting-started/api-keys/rotating-keys.md', 'getting-started/quick-start.md', 'guides/getting-help.md'],
  )
  assert.deepEqual(p.folders, [
    { path: 'getting-started', title: 'Getting Started' },
    { path: 'guides', title: 'Guides' },
    { path: 'getting-started/api-keys', title: 'API keys' },
  ])
  // Sources come back as given, so the browser can find each file.
  assert.equal(p.files[1]!.source, 'Getting Started/Quick Start.md')
})

test('a folder name that’s already a slug gets a readable title', () => {
  assert.deepEqual(ok(plan([['getting-started/a.md']])).folders, [{ path: 'getting-started', title: 'Getting started' }])
})

test('merges into folders that already exist, without listing them to create', () => {
  const p = ok(plan([['Billing/Invoices/Credit notes.md'], ['Billing/Taxes/VAT.md']]))
  assert.deepEqual(
    p.files.map((f) => f.path),
    ['billing/invoices/credit-notes.md', 'billing/taxes/vat.md'],
  )
  assert.deepEqual(p.folders, [{ path: 'billing/taxes', title: 'Taxes' }])
})

test('lands inside the folder it was dropped on', () => {
  const p = ok(plan([['Taxes/VAT.md'], ['overview.md']], { target: 'billing' }))
  assert.deepEqual(
    p.files.map((f) => f.path),
    ['billing/overview.md', 'billing/taxes/vat.md'],
  )
  assert.deepEqual(p.folders, [{ path: 'billing/taxes', title: 'Taxes' }])
})

test('refuses anything more than two folders deep, from every starting depth', () => {
  assert.match(problems(plan([['a/b/c/x.md']])).join(' '), /more than 2 folders deep/)
  assert.match(problems(plan([['a/b/x.md']], { target: 'billing' })).join(' '), /more than 2 folders deep/)
  ok(plan([['a/x.md']], { target: 'billing' }))
  // Into a folder that's already two deep: one clear message, not one per file.
  const deep = problems(plan([['a/x.md'], ['a/y.md']], { target: 'billing/invoices' }))
  assert.equal(deep.length, 1)
  assert.match(deep[0]!, /already 2 levels deep/)
  ok(plan([['x.md']], { target: 'billing/invoices' }))
})

test('skips hidden files, other types and empty files, and says so', () => {
  const p = ok(
    plan([
      ['Docs/.DS_Store'],
      ['Docs/.git/config'],
      ['Docs/logo.png'],
      ['Docs/notes.txt'],
      ['Docs/empty.md', 0],
      ['Docs/real.md'],
    ]),
  )
  assert.deepEqual(
    p.files.map((f) => f.path),
    ['docs/real.md'],
  )
  assert.deepEqual(
    p.skipped.map((s) => [s.source, s.reason]),
    [
      ['Docs/.DS_Store', 'hidden'],
      ['Docs/.git/config', 'hidden'],
      ['Docs/logo.png', 'type'],
      ['Docs/notes.txt', 'type'],
      ['Docs/empty.md', 'empty'],
    ],
  )
  assert.equal(describeSkipped(p.skipped, 'public'), 'Skipped 5 files: 2 that aren’t Markdown, 2 hidden and 1 empty.')
  assert.equal(describeSkipped([], 'public'), '')
})

test('plain-text notes are allowed in private only', () => {
  assert.deepEqual(
    ok(plan([['Notes/Refunds.md'], ['Notes/Escalation.txt']], { visibility: 'private' })).files.map((f) => f.path),
    ['notes/escalation.txt', 'notes/refunds.md'],
  )
  assert.match(problems(plan([['Notes/Escalation.txt']])).join(' '), /no Markdown/)
})

test('refuses files over the size limit, and folders with nothing to upload', () => {
  assert.match(problems(plan([['Docs/huge.md', MB + 1], ['Docs/fine.md']])).join(' '), /“Docs\/huge.md” is over 1 MB/)
  ok(plan([['Docs/exactly.md', MB]]))
  assert.match(problems(plan([['Docs/logo.png'], ['Docs/.DS_Store']])).join(' '), /no Markdown/)
})

test('article names are unique: within the upload and against articles already there', () => {
  // Two returns.md in different folders of the drop.
  assert.match(problems(plan([['A/Returns.md'], ['B/returns.md']])).join(' '), /both be the article “returns”/)
  // One already in billing/invoices.
  assert.match(problems(plan([['Docs/refunds.md']])).join(' '), /already exists at billing\/invoices\/refunds.md/)
  // Two names that clean up to the same file.
  assert.match(problems(plan([['Docs/FAQ.md'], ['Docs/faq.md']])).join(' '), /both be saved as docs\/faq.md/)
  // Private notes may share names across folders.
  ok(plan([['A/notes.md'], ['B/notes.md']], { visibility: 'private' }))
})

test('the same article at the same path is replaced, and flagged', () => {
  const p = ok(plan([['Billing/Plans.md'], ['Billing/Discounts.md']]))
  assert.deepEqual(
    p.files.map((f) => [f.path, f.replaces]),
    [
      ['billing/discounts.md', false],
      ['billing/plans.md', true],
    ],
  )
})

test('a folder and an article beside it never share a web address', () => {
  // A new folder where an article of that name exists (intro.md at the top).
  assert.match(problems(plan([['Intro/setup.md']])).join(' '), /folder “intro” would share a web address/)
  // A new article where a folder of that name exists.
  assert.match(problems(plan([['billing.md']])).join(' '), /share a web address with the folder billing/)
  // Both arriving in the same upload.
  assert.match(problems(plan([['Setup.md'], ['Setup/linux.md']])).join(' '), /folder “setup” would share a web address/)
  // Private notes have no web address.
  ok(plan([['Setup.md'], ['Setup/linux.md']], { visibility: 'private' }))
})

test('paths that climb out or have no usable name are refused', () => {
  assert.match(problems(plan([['../secret.md']])).join(' '), /isn’t a usable path/)
  assert.match(problems(plan([['!!!/x.md']])).join(' '), /needs letters or numbers to be a folder name/)
  assert.match(problems(plan([['Docs/!!!.md']])).join(' '), /needs letters or numbers in its name/)
  // Windows-style separators work.
  assert.deepEqual(
    ok(plan([['Docs\\Setup.md']])).files.map((f) => f.path),
    ['docs/setup.md'],
  )
})

test('a target that no longer exists, and too many files, are refused', () => {
  assert.match(problems(plan([['x.md']], { target: 'gone' })).join(' '), /no longer exists/)
  const many = Array.from({ length: 1001 }, (_, i): [string] => [`Docs/a${i}.md`])
  assert.match(problems(plan(many)).join(' '), /at most 1000 files/)
})

test('problems are summed up in one message', () => {
  assert.equal(describeProblems(['A.', 'B.']), 'A. B.')
  assert.equal(describeProblems(['A.', 'B.', 'C.', 'D.', 'E.']), 'A. B. C. And 2 more problems.')
  assert.equal(describeProblems(['A.', 'B.', 'C.', 'D.']), 'A. B. C. And 1 more problem.')
})

test('batches stay under the request budget, in order, with a big file on its own', () => {
  const sizes = [0.6, 0.6, 0.6, 1, 0.2, 0.1].map((s) => ({ size: s * MB }))
  const batches = packBatches(sizes)
  assert.deepEqual(
    batches.map((b) => b.map((f) => f.size / MB)),
    [[0.6, 0.6], [0.6], [1, 0.2, 0.1]],
  )
  for (const b of batches) assert.ok(b.reduce((n, f) => n + f.size, 0) <= 1.5 * MB)
  assert.deepEqual(packBatches(Array.from({ length: 250 }, () => ({ size: 10 }))).map((b) => b.length), [100, 100, 50])
  assert.deepEqual(packBatches([]), [])
})

test('each batch knows the folders its files need, parents first', () => {
  assert.deepEqual(foldersFor(['a/b/x.md', 'a/y.md', 'c/z.md', 'top.md'], { a: 'Alpha', 'a/b': 'Beta' }), [
    { path: 'a', title: 'Alpha' },
    { path: 'c', title: 'C' },
    { path: 'a/b', title: 'Beta' },
  ])
})

// --- Reading dropped folders (DOM entries faked) ---

type Fake = { name: string; isFile: boolean; isDirectory: boolean; file?: (ok: (f: File) => void) => void; createReader?: () => { readEntries: (ok: (e: Fake[]) => void) => void } }
const fakeFile = (name: string): Fake => ({ name, isFile: true, isDirectory: false, file: (ok) => ok(new File(['x'], name)) })
// Hands its children back `per` at a time, like the browser's 100-at-a-time readEntries.
const fakeDir = (name: string, children: Fake[], per = 100): Fake => ({
  name,
  isFile: false,
  isDirectory: true,
  createReader: () => {
    let at = 0
    return {
      readEntries: (ok) => {
        const chunk = children.slice(at, at + per)
        at += chunk.length
        ok(chunk)
      },
    }
  },
})

test('dropped folders are walked whole, past the 100-entries-a-read limit, with their paths', async () => {
  const many = Array.from({ length: 250 }, (_, i) => fakeFile(`a${i}.md`))
  const dropped = [fakeDir('Docs', [fakeFile('intro.md'), fakeDir('Guides', many), fakeDir('.git', [fakeFile('config')])]), fakeFile('loose.md')]
  const files = await readDropped(dropped as unknown as FileSystemEntry[])
  assert.equal(files.length, 252)
  assert.equal(files[0]!.path, 'Docs/intro.md')
  assert.equal(files[1]!.path, 'Docs/Guides/a0.md')
  assert.equal(files[250]!.path, 'Docs/Guides/a249.md')
  assert.equal(files.at(-1)!.path, 'loose.md')
  assert.ok(!files.some((f) => f.path.includes('.git')), 'hidden folders are not read')
})

test('a huge drop stops with a clear message instead of reading everything', async () => {
  const huge = fakeDir('Everything', Array.from({ length: MAX_PICKED + 1 }, (_, i) => fakeFile(`f${i}.md`)))
  await assert.rejects(readDropped([huge] as unknown as FileSystemEntry[]), /more than 5,000 files/)
})

test('a picked folder keeps each file’s path inside it, and leaves out hidden folders', () => {
  const at = (path: string) => {
    const f = new File(['x'], path.slice(path.lastIndexOf('/') + 1))
    Object.defineProperty(f, 'webkitRelativePath', { value: path })
    return f
  }
  assert.deepEqual(
    pickedFolder([at('Billing/plans.md'), at('Billing/.git/objects/ab/cd'), at('Billing/.DS_Store')]).map((p) => p.path),
    // .DS_Store stays, so the plan can count it as skipped; .git is never read.
    ['Billing/plans.md', 'Billing/.DS_Store'],
  )
  // A huge .git doesn't count against the limit.
  pickedFolder([at('Repo/readme.md'), ...Array.from({ length: MAX_PICKED + 1 }, (_, i) => at(`Repo/.git/objects/${i}`))])
  assert.throws(() => pickedFolder(Array.from({ length: MAX_PICKED + 1 }, () => new File(['x'], 'a.md'))), /more than 5,000/)
})
