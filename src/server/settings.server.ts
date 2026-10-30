import fs from 'node:fs'
import { getRequest, getRequestIP } from '@tanstack/react-start/server'
import { chatStatus } from './chat-availability.server.ts'
import { getDb } from './db.server.ts'
import { env } from './env.server.ts'
import { clientIp } from './auth.server.ts'
import { listDataFiles } from './content.server.ts'
import { rateLimitHits } from './rate-limit.server.ts'
import { LOCK_AFTER_FAILURES } from './account-security.server.ts'
import { getSiteConfig, siteConfigPath } from './site-config.server.ts'
import { assetUrl, brandingChange, readAsset, type StoredAsset } from './branding.server.ts'
import type { BrandAssetKind } from '../lib/brand-assets.ts'
import { aiActivity, appVersion, checkModelRiver, proxyWarning } from './status.server.ts'
import { emailStatus, lastEmailResult } from './email.server.ts'
import { mediaStatus } from './media.server.ts'
import { currentMonth, monthUsage, setupMonth } from './usage.server.ts'

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

type Member = { name: string; email: string }

// The Appearance and SEO tabs: what's saved, what support.config.json says
// underneath (shown as placeholders, and what "Reset" goes back to), and the
// uploaded images.
export function brandingSettings() {
  const { branding, fileConfig, config, logo } = getSiteConfig()
  const image = (kind: BrandAssetKind, asset: StoredAsset | null) =>
    asset && { url: assetUrl(kind, asset), type: asset.type, width: asset.width, height: asset.height, updatedAt: asset.updatedAt, updatedBy: asset.updatedBy }
  return {
    saved: branding,
    name: config.brand.name,
    defaults: {
      name: fileConfig.brand.name,
      brandColor: fileConfig.theme.light.primary,
      // A support.config.json logo shows when nothing is uploaded.
      configLogo: Boolean(fileConfig.brand.logo),
    },
    logo: image('logo', readAsset('logo')),
    logoDark: image('logo-dark', readAsset('logo-dark')),
    favicon: image('favicon', readAsset('favicon')),
    // What each colour scheme shows now (uploads, else support.config.json), and
    // the scheme's colours, so the previews can show both whatever the admin's own scheme.
    current: { logo, light: config.theme.light, dark: config.theme.dark },
    appUrl: env.appUrl,
    changed: brandingChange(),
  }
}

// Everything the admin Settings page shows. Mostly read-only: these come from
// the environment and support.config.json; branding comes from brandingSettings.
// The API key itself is never returned.
export async function collectSettings({ recheck = false } = {}) {
  const db = getDb()

  const members = db.prepare('SELECT name, email, totp_enabled_at, totp_failures FROM users ORDER BY name').all() as Array<
    Member & { totp_enabled_at: string | null; totp_failures: number }
  >
  const files = listDataFiles()
  const headers = getRequest().headers
  const forwardedFor = headers.has('x-forwarded-for')
  const schema = db.prepare('PRAGMA user_version').get() as { user_version: number }
  const { config, logo } = getSiteConfig()
  const subscribers = db
    .prepare('SELECT sum(notify_handoff) AS handoff, sum(notify_new_conversations) AS conversations FROM users')
    .get() as { handoff: number | null; conversations: number | null }

  const [connection, usage] = await Promise.all([checkModelRiver({ force: recheck }), monthUsage(currentMonth())])

  return {
    branding: brandingSettings(),
    chat: chatStatus(db),
    ai: {
      connection,
      apiUrl: env.modelriverApiUrl,
      workflow: env.workflow,
      keySet: Boolean(env.modelriverApiKey),
      ...aiActivity(),
    },
    email: {
      ...emailStatus(),
      appUrl: env.appUrl,
      last: lastEmailResult(),
      // How many team members have each notification on.
      handoffSubscribers: subscribers.handoff ?? 0,
      conversationSubscribers: subscribers.conversations ?? 0,
    },
    media: mediaStatus(),
    usage,
    usageSince: setupMonth(db),
    budget: {
      perMinute: env.globalMessagesPerMinute,
      perDay: env.globalMessagesPerDay,
      usedThisMinute: rateLimitHits('ai-global-minute', MINUTE),
      usedToday: rateLimitHits('ai-global-day', DAY),
    },
    security: {
      twoFactorRequired: !env.twoFactorDisabled,
      members: members.length,
      withoutTwoFactor: members.filter((m) => !m.totp_enabled_at).map(({ name, email }) => ({ name, email })),
      locked: members.filter((m) => m.totp_failures >= LOCK_AFTER_FAILURES).map(({ name, email }) => ({ name, email })),
      secureCookies: env.production,
    },
    network: {
      yourIp: clientIp(),
      socketIp: getRequestIP() ?? 'unknown',
      forwardedFor,
      trustedProxyHops: env.trustedProxyHops,
      clientIpHeader: env.clientIpHeader,
      warning: proxyWarning({ forwardedFor, trustedProxyHops: env.trustedProxyHops, clientIpHeader: env.clientIpHeader }),
      widgetFrameAncestors: env.widgetFrameAncestors,
    },
    content: {
      dataDir: env.dataDir,
      publicFiles: files.filter((f) => f.visibility === 'public').length,
      privateFiles: files.filter((f) => f.visibility === 'private').length,
      archiveRetentionHours: env.archiveRetentionHours,
      visitorCookieDays: env.visitorCookieDays,
    },
    app: {
      version: appVersion(),
      node: process.versions.node,
      databasePath: env.databasePath,
      databaseBytes: fs.existsSync(env.databasePath) ? fs.statSync(env.databasePath).size : 0,
      schemaVersion: schema.user_version,
      configPath: siteConfigPath(),
      brandName: config.brand.name,
      customLogo: logo !== null,
      publicRepoUrl: env.publicRepoUrl,
    },
  }
}
