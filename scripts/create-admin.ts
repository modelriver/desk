// Create an admin, or reset one (password and two-factor), from the command line:
//   npm run create-admin
// Prompts for email, name and password. Uses DATABASE_PATH from .env.
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { getDb, now } from '../src/server/db.server.ts'
import { hashPassword, MIN_PASSWORD_LENGTH } from '../src/server/password.server.ts'

const rl = createInterface({ input: stdin, output: stdout })
const email = (process.env.ADMIN_EMAIL ?? (await rl.question('Admin email: '))).trim()
const name = (process.env.ADMIN_NAME ?? (await rl.question('Name: '))).trim() || email
// readline echoes whatever it reads, so it has to be closed before the hidden prompt.
const password = (process.env.ADMIN_PASSWORD ?? (await askHidden(rl, 'Password (10+ characters): '))).trim()
rl.close()

if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('Enter a valid email.')
if (password.length < MIN_PASSWORD_LENGTH) fail(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`)

const db = getDb()
const hash = await hashPassword(password)
const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email) as { id: string } | undefined
if (existing) {
  // Break-glass: also turns off two-factor and signs the account out, so an
  // admin who lost their phone and recovery codes can set it up again.
  db.exec('BEGIN')
  try {
    db.prepare(
      "UPDATE users SET password_hash = ?, role = 'admin', name = ?, totp_secret = NULL, totp_enabled_at = NULL, totp_last_step = NULL, totp_failures = 0 WHERE id = ?",
    ).run(hash, name, existing.id)
    db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(existing.id)
    db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(existing.id)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  console.log(`Updated ${email}: role admin, new password set, two-factor reset (set it up at your next sign-in).`)
} else {
  db.prepare('INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    crypto.randomUUID(),
    email,
    name,
    hash,
    'admin',
    now(),
  )
  console.log(`Created admin ${email}. Two-factor setup starts at the first sign-in.`)
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

// Read a line without echoing it to the terminal.
async function askHidden(lineReader: typeof rl, prompt: string): Promise<string> {
  if (!stdin.isTTY) return lineReader.question(prompt)
  lineReader.close()
  stdout.write(prompt)
  stdin.setRawMode(true)
  stdin.resume()
  let value = ''
  return new Promise((resolve) => {
    const onData = (buf: Buffer) => {
      for (const ch of buf.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false)
          stdin.off('data', onData)
          stdin.pause()
          stdout.write('\n')
          resolve(value)
          return
        }
        if (ch === '\u0003') process.exit(130)
        if (ch === '\u007f') value = value.slice(0, -1)
        else value += ch
      }
    }
    stdin.on('data', onData)
  })
}
