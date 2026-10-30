import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// The example articles, and a throwaway database (read when the modules load).
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-quick-search-'))
process.env.DATABASE_PATH = path.join(dir, 'desk.db')
process.env.DATA_DIR = path.resolve('examples/data')
const { quickSearch } = await import('../src/server/help.server.ts')
const { listArticles } = await import('../src/server/content.server.ts')

after(() => fs.rmSync(dir, { recursive: true, force: true }))

test('before anything is typed, the search window offers the sections', () => {
  const res = quickSearch('   ')
  assert.equal(res.query, '')
  assert.equal(res.hits, null)
  assert.equal(res.limited, false)
  assert.ok(res.sections && res.sections.length > 0)
  // Only sections with a page of their own, each with its published articles counted.
  const published = listArticles()
  for (const s of res.sections) {
    assert.match(s.path, /^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/)
    assert.equal(s.count, published.filter((a) => a.path.startsWith(`${s.path}/`)).length, s.title)
  }
})
