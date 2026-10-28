import { createServerFn } from '@tanstack/react-start'
import { asObject } from './validate.ts'
import { requireUser } from '../server/auth.server.ts'
import { allowAll } from '../server/rate-limit.server.ts'
import { collectSettings } from '../server/settings.server.ts'
import { sendEmail } from '../server/email.server.ts'
import { currentMonth, monthUsage, MONTH_PATTERN } from '../server/usage.server.ts'

// Admins only: how this install is set up and whether the AI is reachable.
export const getSettings = createServerFn({ method: 'POST' })
  .validator((input: unknown) => ({ recheck: asObject(input ?? {}).recheck === true }))
  .handler(async ({ data }) => {
    const me = requireUser('admin')
    // "Check again" calls ModelRiver; keep that to a few a minute.
    const recheck = data.recheck && allowAll([{ key: `settings-recheck:${me.id}`, max: 6, windowMs: 60_000 }])
    return collectSettings({ recheck })
  })

// Admins only: a month's usage from ModelRiver. `refresh` skips the minute-long cache.
export const getMonthUsage = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const { month, refresh } = asObject(input ?? {})
    return {
      month: typeof month === 'string' && MONTH_PATTERN.test(month) ? month : currentMonth(),
      refresh: refresh === true,
    }
  })
  .handler(async ({ data }) => {
    const me = requireUser('admin')
    const refresh = data.refresh && allowAll([{ key: `usage-refresh:${me.id}`, max: 6, windowMs: 60_000 }])
    return monthUsage(data.month, { refresh })
  })

// Sends a test email to the admin who asked, to prove the provider works.
export const sendTestEmail = createServerFn({ method: 'POST' }).handler(async () => {
  const me = requireUser('admin')
  if (!allowAll([{ key: `test-email:${me.id}`, max: 5, windowMs: 10 * 60_000 }])) {
    throw new Error('That’s a few test emails already. Try again in a few minutes.')
  }
  await sendEmail({
    to: me.email,
    subject: 'Test email from your support dashboard',
    text: 'Email is working. Team notifications (someone waiting for a person, new conversations) will arrive like this.',
    html: '<p style="font-family:system-ui,sans-serif">Email is working. Team notifications (someone waiting for a person, new conversations) will arrive like this.</p>',
  })
  return { sentTo: me.email }
})
