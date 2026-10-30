import path from 'node:path'
import { readMediaStorage } from './media-config.server.ts'

const dataDir = path.resolve(process.env.DATA_DIR ?? './examples/data')

// Read once; every setting comes from process.env (loaded with node --env-file).
export const env = {
  modelriverApiKey: process.env.MODELRIVER_API_KEY ?? '',
  modelriverApiUrl: (process.env.MODELRIVER_API_URL || 'https://api.modelriver.com/v1').replace(/\/+$/, ''),
  workflow: process.env.MODELRIVER_WORKFLOW ?? 'support_assistant',
  dataDir,
  databasePath: path.resolve(process.env.DATABASE_PATH ?? './var/support.db'),
  // Where "Powered by Desk" links (help center footer, chat widget).
  publicRepoUrl: process.env.PUBLIC_REPO_URL || 'https://modelriver.com/desk',
  production: process.env.NODE_ENV === 'production',
  // Reverse proxies in front of the app that append to X-Forwarded-For
  // (nginx = 1, Cloudflare -> nginx = 2).
  trustedProxyHops: intEnv('TRUST_PROXY_HOPS', 0),
  // Header holding the client IP set by a proxy you trust, e.g. cf-connecting-ip.
  clientIpHeader: (process.env.CLIENT_IP_HEADER ?? '').trim().toLowerCase(),
  // Site-wide caps on visitor chat messages, whatever IP they come from, so a
  // distributed flood can't run up unlimited model spend. 0 disables a cap.
  // The defaults fit ModelRiver's Free plan: 30 API calls a minute per IP
  // (every Desk call to ModelRiver counts, so answers get 20 of them) and
  // 25,000 AI requests a month (800 a day × 31 days stays under it).
  globalMessagesPerMinute: intEnv('GLOBAL_MESSAGES_PER_MINUTE', 20),
  globalMessagesPerDay: intEnv('GLOBAL_MESSAGES_PER_DAY', 800),
  // How long a visitor's chat is remembered after their last message (0 = until the browser closes).
  visitorCookieDays: intEnv('VISITOR_COOKIE_DAYS', 30),
  // Turns off the authenticator-code step at sign-in, for everyone. Meant for
  // local development or a dashboard that's only reachable behind your own
  // VPN or SSO; leave it off anywhere the sign-in page is public.
  twoFactorDisabled: boolEnv('DISABLE_TWO_FACTOR', false),
  // Archived conversations are deleted (here and in ModelRiver) this many
  // hours after they were archived. 0 keeps them until restored by hand.
  archiveRetentionHours: intEnv('ARCHIVE_RETENTION_HOURS', 24),
  // Sites allowed to frame /widget (server.mjs applies it; shown in Settings).
  widgetFrameAncestors: process.env.WIDGET_FRAME_ANCESTORS || "'self'",
  // Email notifications: resend, postmark, ses or log (unset = no email).
  emailProvider: emailProviderEnv(),
  // Sender, e.g. "Acme Support <support@acme.com>", on a domain your provider has verified.
  emailFrom: (process.env.EMAIL_FROM ?? '').trim(),
  // The address people use to reach this app, for links in emails, e.g. https://support.acme.com
  appUrl: (process.env.APP_URL ?? '').trim().replace(/\/+$/, ''),
  // How long a visitor's proved email counts, in hours (0 = until the
  // conversation ends). It also lapses after 2 hours without a message.
  verifiedHours: intEnv('VERIFIED_HOURS', 24),
  // Encrypts connector keys entered in Integrations (32 bytes, base64). Without
  // it, connector keys can only come from the environment.
  secretKey: secretKeyEnv('DESK_SECRET_KEY'),
  // Signs visitor identity tokens from your own site (see README, Integrations).
  identitySecret: identitySecretEnv('DESK_IDENTITY_SECRET'),
  // Lets Custom HTTP and a self-hosted Cal.com reach private network addresses
  // (10.x, 192.168.x, localhost...). Off by default so a connector URL can't be
  // pointed at internal services.
  allowPrivateConnectorUrls: boolEnv('DESK_ALLOW_PRIVATE_CONNECTOR_URLS', false),
  // Images uploaded into articles: a folder here, or S3-compatible storage (see media-config.server.ts).
  media: readMediaStorage(process.env, dataDir),
}

if (env.twoFactorDisabled) {
  console.warn('[auth] DISABLE_TWO_FACTOR is on: team members sign in with a password only.')
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a whole number >= 0.`)
  return value
}

function emailProviderEnv(): 'resend' | 'postmark' | 'ses' | 'log' | null {
  const raw = (process.env.EMAIL_PROVIDER ?? '').trim().toLowerCase()
  if (!raw) return null
  if (raw === 'resend' || raw === 'postmark' || raw === 'ses' || raw === 'log') return raw
  throw new Error('EMAIL_PROVIDER must be resend, postmark, ses or log.')
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = (process.env[name] ?? '').trim().toLowerCase()
  if (raw === '') return fallback
  if (raw === 'true' || raw === '1') return true
  if (raw === 'false' || raw === '0') return false
  throw new Error(`${name} must be true or false.`)
}

function secretKeyEnv(name: string): Buffer | null {
  const raw = (process.env[name] ?? '').trim()
  if (!raw) return null
  const key = Buffer.from(raw, 'base64')
  if (key.length !== 32) throw new Error(`${name} must be 32 bytes, base64-encoded. Generate one with: openssl rand -base64 32`)
  return key
}

function identitySecretEnv(name: string): string {
  const raw = (process.env[name] ?? '').trim()
  if (raw && raw.length < 32) throw new Error(`${name} must be at least 32 characters. Generate one with: openssl rand -base64 32`)
  return raw
}

export function requireApiKey(): string {
  if (!env.modelriverApiKey) {
    throw new Error('MODELRIVER_API_KEY is not set. Add it to .env (see .env.example).')
  }
  return env.modelriverApiKey
}
