import { createServerFn } from '@tanstack/react-start'
import { asObject, str } from './validate.ts'
import { requireUser } from '../server/auth.server.ts'
import { dismissGap, feedbackSummary, listGaps, RETENTION_DAYS } from '../server/insights.server.ts'

// The team's view of what the help center is missing.
export const getInsights = createServerFn({ method: 'GET' }).handler(() => {
  requireUser()
  return { gaps: listGaps({ days: 30 }), feedback: feedbackSummary(), retentionDays: RETENTION_DAYS }
})

export const dismissInsight = createServerFn({ method: 'POST' })
  .validator((input: unknown) => ({ normalized: str(asObject(input), 'normalized', { max: 400 }) }))
  .handler(({ data }) => {
    requireUser()
    dismissGap(data.normalized)
    return { ok: true }
  })
