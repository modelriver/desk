import { createServerFn } from '@tanstack/react-start'
import { asObject, str } from './validate.ts'
import { listArticles } from '../server/content.server.ts'
import { helpIndex, helpPage, voteOnArticle } from '../server/help.server.ts'
import { env } from '../server/env.server.ts'
import { getSiteConfig as readSiteConfig } from '../server/site-config.server.ts'

export const getArticles = createServerFn({ method: 'GET' }).handler(async () => listArticles())

// The help center's front page: every article, or search results for `q`.
export const getHelpIndex = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    const q = asObject(input ?? {}).q
    return { q: typeof q === 'string' ? q : '' }
  })
  .handler(async ({ data }) => helpIndex(data.q))

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
  const { config, css, logo } = readSiteConfig()
  return {
    repoUrl: env.publicRepoUrl,
    brandName: config.brand.name,
    logo,
    themeCss: css,
    fontStylesheets: config.fonts.stylesheets,
  }
})
