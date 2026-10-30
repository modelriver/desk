import { useState } from 'react'
import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { dismissInsight, getInsights } from '../../functions/insights.ts'
import { LoadError } from '../../components/LoadError.tsx'
import { RelativeTime } from '../../components/RelativeTime.tsx'
import { HelpBot } from '../../components/HelpBot.tsx'
import { Badge, Button, Card, Notice, PageHeader } from '../../components/ui.tsx'
import { cn } from '../../lib/cn.ts'
import { errorMessage } from '../../lib/errors.ts'
import { articleUrl } from '../../lib/help-path.ts'

// What to write or fix next: questions the help center couldn't answer, and
// how helpful visitors found each article.
export const Route = createFileRoute('/dashboard/insights')({
  head: () => ({ meta: [{ title: 'Insights · Dashboard' }] }),
  loader: () => getInsights(),
  errorComponent: ({ error }) => (
    <>
      <PageHeader title="Insights" />
      <LoadError title="Couldn’t load insights" error={error} />
    </>
  ),
  component: InsightsPage,
})

const REASON: Record<'no_match' | 'unsure' | 'ai_error', { label: string; title: string }> = {
  no_match: { label: 'No article matched', title: 'Nothing in the articles or notes matched the question' },
  unsure: { label: 'AI wasn’t sure', title: 'The articles didn’t answer it, and the AI said so' },
  ai_error: { label: 'AI error', title: 'The AI failed, so the question went to the team' },
}

function InsightsPage() {
  const { gaps, feedback, retentionDays } = Route.useLoaderData()
  const router = useRouter()
  const dismiss = useServerFn(dismissInsight)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const rated = feedback.filter((f) => f.helpful + f.notHelpful > 0)

  return (
    <>
      <PageHeader title="Insights" description="What to write or fix next in the help center." />

      <section aria-labelledby="gaps">
        <h2 id="gaps" className="text-sm font-semibold">
          Questions the help center couldn’t answer
        </h2>
        <p className="mt-0.5 max-w-prose text-sm text-muted-foreground">
          From the last 30 days, most asked first. Write an article, then mark it handled. Questions are kept for{' '}
          {retentionDays} days.
        </p>
        {error && (
          <div className="mt-2">
            <Notice tone="error">{error}</Notice>
          </div>
        )}
        {gaps.length === 0 ? (
          <Card className="mt-3 flex items-center gap-4 p-5">
            <HelpBot body="figure" mood="happy" size={64} />
            <p className="text-sm text-muted-foreground">Nothing unanswered right now. Visitors’ questions are covered.</p>
          </Card>
        ) : (
          <ul className="mt-3 divide-y divide-border rounded-xl border border-border bg-card">
            {gaps.map((g) => (
              <li key={g.normalized} className="flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm [overflow-wrap:anywhere]">“{g.question}”</p>
                  <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <span>
                      {g.count === 1 ? 'Asked once' : `Asked ${g.count} times`}, last <RelativeTime iso={g.lastAskedAt} />
                    </span>
                    {g.reasons.map((r) => (
                      <Badge key={r} variant={r === 'ai_error' ? 'outline' : 'muted'} title={REASON[r].title}>
                        {REASON[r].label}
                      </Badge>
                    ))}
                    {g.sessionId && (
                      <Link to="/dashboard/c/$sessionId" params={{ sessionId: g.sessionId }} className="underline-offset-4 hover:text-foreground hover:underline">
                        Open conversation
                      </Link>
                    )}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy !== null}
                  onClick={async () => {
                    setBusy(g.normalized)
                    setError(null)
                    try {
                      await dismiss({ data: { normalized: g.normalized } })
                      await router.invalidate()
                    } catch (err) {
                      setError(errorMessage(err, 'Couldn’t mark it handled. Try again.'))
                    } finally {
                      setBusy(null)
                    }
                  }}
                >
                  Mark handled
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="ratings" className="mt-10">
        <h2 id="ratings" className="text-sm font-semibold">
          Article ratings
        </h2>
        <p className="mt-0.5 max-w-prose text-sm text-muted-foreground">
          From “Was this article helpful?” at the end of each article. Least helpful first.
        </p>
        {rated.length === 0 ? (
          <Card className="mt-3 p-5 text-sm text-muted-foreground">No votes yet.</Card>
        ) : (
          <ul className="mt-3 divide-y divide-border rounded-xl border border-border bg-card">
            {rated.map((f) => {
              const total = f.helpful + f.notHelpful
              const share = Math.round((f.helpful / total) * 100)
              return (
                <li key={f.slug} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 text-sm">
                  <a href={articleUrl(f.slug)} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 truncate underline-offset-4 hover:underline">
                    {f.title}
                  </a>
                  <span className="text-muted-foreground">
                    {f.helpful} yes, {f.notHelpful} no
                  </span>
                  <span className="flex w-36 items-center gap-2">
                    <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                      <span className={cn('block h-full rounded-full', share < 50 ? 'bg-destructive' : 'bg-success')} style={{ width: `${share}%` }} />
                    </span>
                    <span className="w-10 text-right tabular-nums">{share}%</span>
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </>
  )
}
