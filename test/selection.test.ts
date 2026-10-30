import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  draftKeys,
  filesIn,
  folderState,
  selectedFiles,
  selectionKey,
  toggleKeys,
  type SelectableFile,
  type SelectableFolder,
  type SelectionTree,
} from '../src/lib/selection.ts'

// A tree in the shape the Data page gets from the server.
const file = (path: string, title: string, draft = false): SelectableFile => ({ kind: 'file', name: path.slice(path.lastIndexOf('/') + 1), path, title, draft })
const folder = (path: string, children: SelectableFolder['children']): SelectableFolder => ({ kind: 'folder', name: path.slice(path.lastIndexOf('/') + 1), path, title: path, children })

const tree = (): SelectionTree => ({
  public: folder('', [
    folder('billing', [file('billing/plans.md', 'Plans', true), file('billing/refunds.md', 'Refunds'), folder('billing/tax', [file('billing/tax/vat.md', 'VAT', true)])]),
    file('intro.md', 'Welcome', true),
  ]),
  private: folder('', [file('escalation.txt', 'escalation.txt'), file('tone.md', 'Tone of voice', true)]),
})
const pub = (path: string) => selectionKey('public', path)

test('a folder’s checkbox covers every Markdown file under it, filtered like the page', () => {
  const billing = tree().public.children[0] as SelectableFolder
  assert.deepEqual(filesIn('public', billing), [pub('billing/plans.md'), pub('billing/refunds.md'), pub('billing/tax/vat.md')])
  // With a filter, only what's showing.
  assert.deepEqual(filesIn('public', billing, 'vat'), [pub('billing/tax/vat.md')])
  // The filter matches file names as well as titles.
  assert.deepEqual(filesIn('public', billing, 'refunds.md'), [pub('billing/refunds.md')])
  // Plain-text notes can't be drafts, so they're never selectable.
  assert.deepEqual(filesIn('private', tree().private), [selectionKey('private', 'tone.md')])
})

test('a folder shows all, some or none of its files selected', () => {
  const keys = [pub('a.md'), pub('b.md')]
  assert.equal(folderState(keys, new Set()), 'none')
  assert.equal(folderState(keys, new Set([pub('a.md')])), 'some')
  assert.equal(folderState(keys, new Set(keys)), 'all')
  assert.equal(folderState([], new Set()), 'none', 'an empty folder is never "all"')
})

test('ticking a folder selects all of it; ticking it again when all are selected clears it', () => {
  const keys = [pub('a.md'), pub('b.md')]
  const some = new Set([pub('a.md'), pub('other.md')])
  const all = toggleKeys(some, keys)
  assert.deepEqual([...all].sort(), [pub('a.md'), pub('b.md'), pub('other.md')])
  const cleared = toggleKeys(all, keys)
  assert.deepEqual([...cleared], [pub('other.md')], 'what was selected elsewhere stays')
  // The original is never changed (React state).
  assert.deepEqual([...some].sort(), [pub('a.md'), pub('other.md')])
  // An empty list changes nothing.
  assert.deepEqual([...toggleKeys(some, [])].sort(), [...some].sort())
})

test('the selection lists files that still exist, in tree order, with their status', () => {
  const selected = new Set([selectionKey('private', 'tone.md'), pub('intro.md'), pub('billing/refunds.md'), pub('gone.md'), selectionKey('private', 'escalation.txt')])
  assert.deepEqual(selectedFiles(tree(), selected), [
    { visibility: 'public', path: 'billing/refunds.md', title: 'Refunds', draft: false },
    { visibility: 'public', path: 'intro.md', title: 'Welcome', draft: true },
    { visibility: 'private', path: 'tone.md', title: 'Tone of voice', draft: true },
  ])
  assert.deepEqual(selectedFiles(tree(), new Set()), [])
})

test('“Select all drafts” finds every draft, public and private, filtered like the page', () => {
  assert.deepEqual(draftKeys(tree()), [pub('billing/plans.md'), pub('billing/tax/vat.md'), pub('intro.md'), selectionKey('private', 'tone.md')])
  assert.deepEqual(draftKeys(tree(), 'welcome'), [pub('intro.md')])
})
