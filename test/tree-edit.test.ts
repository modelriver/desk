import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyMove } from '../src/lib/tree-edit.ts'

// A small tree in the shape the Data page gets from the server.
const file = (path: string) => ({ kind: 'file' as const, name: path.slice(path.lastIndexOf('/') + 1), path })
const folder = (path: string, children: Array<ReturnType<typeof file> | Folder>): Folder => ({
  kind: 'folder',
  name: path.slice(path.lastIndexOf('/') + 1),
  path,
  children,
})
interface Folder {
  kind: 'folder'
  name: string
  path: string
  children: Array<ReturnType<typeof file> | Folder>
}

const tree = () => ({
  public: folder('', [folder('billing', [file('billing/plans.md'), file('billing/refunds.md')]), file('intro.md'), file('faq.md')]),
  private: folder('', [file('notes.md')]),
})
const names = (f: Folder) => f.children.map((c) => c.name)

test('reorders within a folder, before an item or at the end', () => {
  const up = applyMove(tree(), { from: { visibility: 'public', path: 'faq.md', kind: 'file' }, to: { visibility: 'public', folder: '', before: 'intro.md' } })
  assert.deepEqual(names(up.data.public), ['billing', 'faq.md', 'intro.md'])
  const last = applyMove(tree(), { from: { visibility: 'public', path: 'billing', kind: 'folder' }, to: { visibility: 'public', folder: '', before: null } })
  assert.deepEqual(names(last.data.public), ['intro.md', 'faq.md', 'billing'])
})

test('moves into another folder, and paths inside a moved folder follow', () => {
  const t = tree()
  const { data, path } = applyMove(t, { from: { visibility: 'public', path: 'intro.md', kind: 'file' }, to: { visibility: 'public', folder: 'billing', before: 'refunds.md' } })
  assert.equal(path, 'billing/intro.md')
  const billing = data.public.children[0] as Folder
  assert.deepEqual(names(billing), ['plans.md', 'intro.md', 'refunds.md'])
  assert.equal(billing.children[1]!.path, 'billing/intro.md')
  assert.deepEqual(names(data.public), ['billing', 'faq.md'])
  // The original is untouched (Cancel and Undo rely on it).
  assert.deepEqual(names(t.public), ['billing', 'intro.md', 'faq.md'])

  const nested = applyMove(
    { public: folder('', [folder('a', []), folder('b', [file('b/x.md')])]), private: folder('', []) },
    { from: { visibility: 'public', path: 'b', kind: 'folder' }, to: { visibility: 'public', folder: 'a', before: null } },
  )
  const a = nested.data.public.children[0] as Folder
  assert.equal(a.children[0]!.path, 'a/b')
  assert.equal((a.children[0] as Folder).children[0]!.path, 'a/b/x.md')
})

test('moves between public and private', () => {
  const { data } = applyMove(tree(), { from: { visibility: 'private', path: 'notes.md', kind: 'file' }, to: { visibility: 'public', folder: 'billing', before: null } })
  assert.deepEqual(names(data.private), [])
  assert.deepEqual(names(data.public.children[0] as Folder), ['plans.md', 'refunds.md', 'notes.md'])
})

test('refuses an item that isn’t there', () => {
  assert.throws(() => applyMove(tree(), { from: { visibility: 'public', path: 'gone.md', kind: 'file' }, to: { visibility: 'public', folder: '', before: null } }), Error)
})
