import { createServerFn } from '@tanstack/react-start'
import { chatEnabled, handoffEnabled, ticketsEnabled } from '../server/chat-availability.server.ts'
import { asObject, str } from './validate.ts'
import { helpIndex, helpPage, homePage, quickSearch, voteOnArticle } from '../server/help.server.ts'
import { emailStatus } from '../server/email.server.ts'
import { env } from '../server/env.server.ts'
import { siteUrl } from '../server/seo.server.ts'
import { getSiteConfig as readSiteConfig } from '../server/site-config.server.ts'

export const getHome = createServerFn({ method: 'GET' }).handler(async () => homePage())

// The help center's front page: every article, or search results for `q`.
export const getHelpIndex = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    const q = asObject(input ?? {}).q
    return { q: typeof q === 'string' ? q : '' }
  })
  .handler(async ({ data }) => helpIndex(data.q))

// The search window's results as someone types (see quickSearch).
export const searchArticlesQuick = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    const q = asObject(input ?? {}).q
    return { q: typeof q === 'string' ? q : '' }
  })
  .handler(async ({ data }) => quickSearch(data.q))

// A section's page, an article, or where an old article link points now.
export const getHelpPage = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    const path = asObject(input).path
    if (typeof path !== 'string' || path.length > 300 || !/^[a-z0-9/-]*$/.test(path)) return { path: '' }
    return { path }
  })
  .handler(async ({ data }) => helpPage(data.path))

export const voteArticle = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const o = asObject(input)
    if (typeof o.helpful !== 'boolean') throw new Error('Choose yes or no.')
    return { slug: str(o, 'slug', { max: 80 }), helpful: o.helpful }
  })
  .handler(async ({ data }) => voteOnArticle(data.slug, data.helpful))

// Everything the root layout needs from support.config.json and env.
export const getSiteConfig = createServerFn({ method: 'GET' }).handler(async () => {
  const { config, css, logo, favicon, showName, seo, home } = readSiteConfig()
  return {
    repoUrl: env.publicRepoUrl,
    brandName: config.brand.name,
    // Written beside the logo in the header (off for a logo that spells it out).
    showName,
    // The home page's title and description from Settings (null for the defaults).
    seo,
    // The home page's hero text from Settings (null for the defaults).
    home,
    favicon,
    // For canonical links and structured data (see siteUrl).
    siteUrl: siteUrl(),
    // The browser's own bars (mobile Safari, Chrome) in the page's background colour.
    themeColors: { light: config.theme.light.background, dark: config.theme.dark.background },
    logo,
    themeCss: css,
    fontStylesheets: config.fonts.stylesheets,
    // Paused from Settings: the chat button and the ways into it are hidden.
    chatEnabled: chatEnabled(),
    // "Talk with a person" off: the home page's default line offers a message instead.
    teamCanJoin: handoffEnabled(),
    // New tickets off: nothing offers to raise one.
    ticketsOpen: ticketsEnabled(),
    // Customers sign in to /customer-portal with an email code, so it's only linked when email works.
    customerPortal: emailStatus().ready,
  }
})
