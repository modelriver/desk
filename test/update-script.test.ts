import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// deploy/update.sh (desk-update) against a pretend server: its folders under
// DESK_UPDATE_ROOT, releases tagged in a local git repository, and stubs for
// the commands that need a real server (systemctl, setpriv, flock, npm, curl).

const script = path.resolve('deploy/update.sh')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-update-'))
const root = path.join(dir, 'root')
const remote = path.join(dir, 'remote')
const stubs = path.join(dir, 'bin')
const log = path.join(dir, 'calls.log')
const app = path.join(root, 'opt/desk')
const nodeVersion = process.versions.node

after(() => fs.rmSync(dir, { recursive: true, force: true }))

const write = (file: string, content: string, mode = 0o644) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, { mode })
}
const versionOf = (folder: string) => (JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8')) as { version: string }).version
const git = (...args: string[]) => execFileSync('git', ['-C', remote, ...args], { stdio: 'pipe' })

// A Desk release: what update.sh reads from a checkout.
function release(folder: string, version: string) {
  write(path.join(folder, 'package.json'), JSON.stringify({ name: 'desk', version }))
  write(path.join(folder, '.nvmrc'), `${nodeVersion}\n`)
  write(path.join(folder, 'deploy/desk.service'), `# desk ${version}\n`)
  fs.copyFileSync(script, path.join(folder, 'deploy/update.sh'))
}

before(() => {
  // Releases 1.0.0 to 2.0.0, each a tag, the way GitHub has them.
  fs.mkdirSync(remote)
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@desk.test')
  git('config', 'user.name', 'Test')
  for (const v of ['1.0.0', '1.1.0', '1.1.1', '2.0.0']) {
    release(remote, v)
    git('add', '-A')
    git('commit', '-q', '-m', `Release ${v}`)
    git('tag', `v${v}`)
  }

  // The server: Desk 1.1.0 installed, with data, settings and a database.
  release(app, '1.1.0')
  write(path.join(root, 'etc/desk/env'), 'PORT=3999\nDATABASE_PATH=/var/lib/desk/desk.db\nMODELRIVER_API_KEY=secret\n')
  write(path.join(root, 'etc/desk/setup.conf'), `REPO=file://${remote}\n`)
  write(path.join(root, 'var/lib/desk/data/public/hello.md'), '# Hello\n')
  for (const d of ['etc/systemd/system', 'usr/local/bin']) fs.mkdirSync(path.join(root, d), { recursive: true })
  const db = new DatabaseSync(path.join(root, 'var/lib/desk/desk.db'))
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE notes (x TEXT); INSERT INTO notes VALUES ('kept')")
  db.close()

  // Stubs. setpriv runs the command as is; install drops -o/-g (no desk user
  // here); curl answers unless the running version is $BAD_VERSION; npm
  // fails its build when the checkout is $BROKEN_BUILD.
  const stub = (name: string, body: string) => write(path.join(stubs, name), `#!/usr/bin/env bash\n${body}\n`, 0o755)
  stub('setpriv', 'while [ "$1" != "--" ]; do shift; done; shift; exec "$@"')
  stub('flock', 'exit 0')
  stub('sleep', 'exit 0')
  stub('systemctl', `echo "systemctl $*" >>"${log}"`)
  stub('journalctl', 'echo "(journal)"')
  stub('install', `args=(); skip=0; for a in "$@"; do if [ "$skip" = 1 ]; then skip=0; continue; fi; case "$a" in -o|-g) skip=1 ;; *) args+=("$a") ;; esac; done; exec /usr/bin/install "\${args[@]}"`)
  stub(
    'curl',
    `v="$(node -p 'require(process.argv[1]).version' "$DESK_UPDATE_ROOT/opt/desk/package.json")"; [ "$v" != "\${BAD_VERSION:-}" ]`,
  )
  stub(
    'npm',
    `echo "npm $* in $(basename "$PWD") $(node -p 'require("./package.json").version')" >>"${log}"
if [ "$1 $2" = "run build" ] && [ "$(node -p 'require("./package.json").version')" = "\${BROKEN_BUILD:-}" ]; then exit 1; fi
[ "$1" = ci ] && mkdir -p node_modules
[ "$1 $2" = "run build" ] && mkdir -p dist
exit 0`,
  )
})

function update(args: string[], env: Record<string, string> = {}) {
  const res = spawnSync('bash', [script, ...args], {
    env: { ...process.env, DESK_UPDATE_ROOT: root, PATH: `${stubs}:${process.env.PATH}`, ...env },
    encoding: 'utf8',
  })
  return { code: res.status, out: `${res.stdout}${res.stderr}` }
}

const backups = () => fs.readdirSync(path.join(root, 'var/backups/desk')).filter((f) => f.endsWith('.tgz'))

test('--check shows the installed version and what is out, changing nothing', () => {
  const { code, out } = update(['--check'])
  assert.equal(code, 0, out)
  assert.match(out, /Installed: 1\.1\.0/)
  assert.match(out, /Newest 1\.x:\s+1\.1\.1/)
  assert.match(out, /Newest:\s+2\.0\.0 \(a new major version/)
  assert.equal(versionOf(app), '1.1.0')
})

test('an update goes to the newest release of the same major version, with a backup first', () => {
  const { code, out } = update([])
  assert.equal(code, 0, out)
  assert.match(out, /Updating Desk 1\.1\.0 to 1\.1\.1/)
  assert.equal(versionOf(app), '1.1.1')
  assert.equal(versionOf(path.join(root, 'opt/desk.prev')), '1.1.0')
  assert.ok(fs.existsSync(path.join(app, 'dist')), 'built')
  assert.equal(fs.existsSync(path.join(root, 'opt/desk.next')), false)
  // The service file and this command come from the new version.
  assert.equal(fs.readFileSync(path.join(root, 'etc/systemd/system/desk.service'), 'utf8'), '# desk 1.1.1\n')
  assert.ok(fs.existsSync(path.join(root, 'usr/local/bin/desk-update')))
  assert.match(fs.readFileSync(log, 'utf8'), /systemctl restart desk/)

  // The backup: data and settings, and a readable copy of the database.
  const [backup] = backups()
  assert.match(backup!, /^desk-1\.1\.0-\d{8}-\d{6}\.tgz$/)
  // Nothing that would land on the folder it's unpacked into ("./" would
  // carry the scratch folder's permissions onto /).
  const members = execFileSync('tar', ['-tzf', path.join(root, 'var/backups/desk', backup!)], { encoding: 'utf8' }).trim().split('\n')
  assert.ok(!members.some((m) => m === '.' || m === './'), members.join(', '))
  assert.deepEqual([...new Set(members.map((m) => m.split('/')[0]))].sort(), ['desk.db', 'etc', 'var'])
  const out2 = path.join(dir, 'restore')
  fs.mkdirSync(out2)
  execFileSync('tar', ['-xzf', path.join(root, 'var/backups/desk', backup!), '-C', out2])
  assert.ok(fs.existsSync(path.join(out2, 'var/lib/desk/data/public/hello.md')))
  assert.ok(fs.existsSync(path.join(out2, 'etc/desk/env')))
  assert.equal(fs.existsSync(path.join(out2, 'var/lib/desk/desk.db')), false, 'the live database file is left out')
  const copy = new DatabaseSync(path.join(out2, 'desk.db'), { readOnly: true })
  assert.deepEqual({ ...copy.prepare('SELECT x FROM notes').get() }, { x: 'kept' })
  copy.close()
})

test('nothing to do on the newest release; a new major version is only mentioned', () => {
  const { code, out } = update([])
  assert.equal(code, 0, out)
  assert.match(out, /1\.1\.1 is the newest 1\.x release; nothing to do/)
  assert.match(out, /Desk 2\.0\.0 is out/)
  assert.equal(versionOf(app), '1.1.1')
})

test('--rollback goes back, and again returns', () => {
  let res = update(['--rollback'])
  assert.equal(res.code, 0, res.out)
  assert.equal(versionOf(app), '1.1.0')
  assert.equal(versionOf(path.join(root, 'opt/desk.prev')), '1.1.1')
  res = update(['--rollback'])
  assert.equal(res.code, 0, res.out)
  assert.equal(versionOf(app), '1.1.1')
})

test('a version that does not start is undone automatically', () => {
  const { code, out } = update(['2.0.0'], { BAD_VERSION: '2.0.0' })
  assert.notEqual(code, 0)
  assert.match(out, /2\.0\.0 didn't answer/)
  assert.match(out, /Desk 1\.1\.1 is running again/)
  assert.equal(versionOf(app), '1.1.1')
  assert.equal(versionOf(path.join(root, 'opt/desk.next')), '2.0.0', 'the failed build is kept to look at')
  assert.equal(fs.readFileSync(path.join(root, 'etc/systemd/system/desk.service'), 'utf8'), '# desk 1.1.1\n')
})

test('a failed build leaves the running version alone', () => {
  const { code, out } = update(['1.0.0'], { BROKEN_BUILD: '1.0.0' })
  assert.notEqual(code, 0)
  assert.match(out, /The build failed .* Desk 1\.1\.1 is still running, unchanged/)
  assert.equal(versionOf(app), '1.1.1')
})

test('an unknown version is refused before anything changes', () => {
  const before = backups().length
  const { code, out } = update(['9.9.9'])
  assert.notEqual(code, 0)
  assert.match(out, /There's no release 9\.9\.9/)
  assert.equal(backups().length, before)
})

test('only the newest three backups are kept', () => {
  for (const v of ['1.1.0', '1.1.1', '1.1.0']) {
    const res = update([v])
    assert.equal(res.code, 0, res.out)
  }
  assert.equal(backups().length, 3)
  assert.equal(versionOf(app), '1.1.0')
})
