// Fails if the lockfile resolves TanStack Start packages below the versions
// that fix CVE-2026-102989 (reflected XSS in server-function responses), or if
// any @tanstack/* dependency in package.json is not pinned to an exact version.
import { readFileSync } from 'node:fs'

const MINIMUMS = {
  '@tanstack/react-start': '1.168.60',
  '@tanstack/start-server-core': '1.169.39',
}

const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'))
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
let failed = false

const cmp = (a, b) => {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i]
  return 0
}

for (const [name, min] of Object.entries(MINIMUMS)) {
  const found = Object.entries(lock.packages ?? {}).filter(([path]) => path.endsWith(`node_modules/${name}`))
  if (!found.length) {
    console.error(`✗ ${name} not found in package-lock.json`)
    failed = true
  }
  for (const [path, info] of found) {
    const ok = cmp(info.version, min) >= 0
    console.log(`${ok ? '✓' : '✗'} ${path} ${info.version} (need >= ${min})`)
    if (!ok) failed = true
  }
}

for (const [name, range] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
  if (name.startsWith('@tanstack/') && !/^\d+\.\d+\.\d+$/.test(range)) {
    console.error(`✗ ${name} must be pinned to an exact version, found "${range}"`)
    failed = true
  }
}

process.exit(failed ? 1 : 0)
