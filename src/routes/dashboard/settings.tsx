import { useState, type ReactNode } from 'react'
import { createFileRoute, redirect } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { getMonthUsage, getSettings, sendTestEmail } from '../../functions/settings.ts'
import { LoadError } from '../../components/LoadError.tsx'
import { RefreshIcon } from '../../components/icons.tsx'
import { Badge, Button, Notice, PageHeader, Section, Select } from '../../components/ui.tsx'
import { RelativeTime } from '../../components/RelativeTime.tsx'
import { cn } from '../../lib/cn.ts'
import { BusyIcon } from '../../components/BusyIcon.tsx'
import { errorMessage } from '../../lib/errors.ts'

export const Route = createFileRoute('/dashboard/settings')({
  beforeLoad: ({ context }) => {
    if (context.user.role !== 'admin') throw redirect({ to: '/dashboard' })
  },
  loader: () => getSettings({ data: { recheck: false } }),
  errorComponent: ({ error }) => (
    <>
      <PageHeader title="Settings" />
      <LoadError title="Couldn’t load settings" error={error} />
    </>
  ),
  component: Settings,
})

type Data = Awaited<ReturnType<typeof getSettings>>

const CONNECTION = {
  connected: { label: 'Connected', tone: 'ok' },
  no_key: { label: 'No API key', tone: 'bad' },
  rejected: { label: 'API key rejected', tone: 'bad' },
  unreachable: { label: 'Can’t reach ModelRiver', tone: 'bad' },
  error: { label: 'Error', tone: 'bad' },
} as const

// Read-only: everything here comes from the server's environment and
// support.config.json, so the page says where to change it.
function Settings() {
  const loaded = Route.useLoaderData()
  const fetchSettings = useServerFn(getSettings)
  const [data, setData] = useState<Data>(loaded)
  const [checking, setChecking] = useState(false)
  const s = data

  const recheck = async () => {
    setChecking(true)
    try {
      setData(await fetchSettings({ data: { recheck: true } }))
    } finally {
      setChecking(false)
    }
  }

  const conn = CONNECTION[s.ai.connection.state]
  const nf = new Intl.NumberFormat('en')

  return (
    <>
      <PageHeader
        title="Settings"
        description="How this install is set up, and whether the AI is reachable. Values come from the server’s environment and support.config.json: change them there and restart the app. Only admins see this page."
      />

      <div className="grid gap-5">
        <Section title="AI connection">
          <div className="flex flex-wrap items-start gap-3 border-b border-border px-5 py-4">
            <span
              className={cn('mt-1.5 size-2.5 shrink-0 rounded-full', conn.tone === 'ok' ? 'bg-success' : 'bg-destructive')}
              aria-hidden="true"
            />
            <div className="min-w-0 flex-1">
              <p className="font-medium">{conn.label}</p>
              <p className="mt-0.5 text-sm text-muted-foreground">{s.ai.connection.detail}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Checked <RelativeTime iso={s.ai.connection.checkedAt} />
                {s.ai.connection.latencyMs !== null && <> in {s.ai.connection.latencyMs} ms</>}
              </p>
            </div>
            <Button variant="outline" size="sm" disabled={checking} onClick={() => void recheck()}>
              <BusyIcon busy={checking} size={14} idle={<RefreshIcon size={14} />} />
              Check again
            </Button>
          </div>
          <Row label="ModelRiver API" setting="MODELRIVER_API_URL">
            <Code>{s.ai.apiUrl}</Code>
          </Row>
          <Row label="Workflow" setting="MODELRIVER_WORKFLOW">
            <Code>{s.ai.workflow}</Code>
          </Row>
          <Row label="API key" setting="MODELRIVER_API_KEY">
            {s.ai.keySet ? <Badge variant="success">Set</Badge> : <Badge variant="danger">Not set</Badge>}
          </Row>
          <Row label="Last answer started" hint="Since the server started.">
            {s.ai.lastAnswerAt ? <RelativeTime iso={s.ai.lastAnswerAt} /> : <Muted>None yet</Muted>}
          </Row>
          <Row label="Last time the AI couldn’t answer" hint="Those chats went to the team.">
            {s.ai.lastFailure ? (
              <span className="text-right">
                <RelativeTime iso={s.ai.lastFailure.at} />
                <span className="block text-xs text-muted-foreground">{s.ai.lastFailure.reason}</span>
              </span>
            ) : (
              <Muted>None since the server started</Muted>
            )}
          </Row>
        </Section>

        <EmailSection email={s.email} onSent={() => void fetchSettings({ data: { recheck: false } }).then(setData)} />

        <UsageSection initial={s.usage} since={s.usageSince} />

        <Section title="AI budget" description="Site-wide caps on AI answers, whoever asks. When one is used up, new questions go to the team. Counts restart with the server.">
          <Row label="This minute" setting="GLOBAL_MESSAGES_PER_MINUTE">
            <Usage used={s.budget.usedThisMinute} max={s.budget.perMinute} nf={nf} />
          </Row>
          <Row label="Last 24 hours" setting="GLOBAL_MESSAGES_PER_DAY">
            <Usage used={s.budget.usedToday} max={s.budget.perDay} nf={nf} />
          </Row>
        </Section>

        <Section title="Sign-in security">
          <Row label="Two-factor sign-in" setting="DISABLE_TWO_FACTOR">
            {s.security.twoFactorRequired ? (
              <Badge variant="success">Required for everyone</Badge>
            ) : (
              <Badge variant="danger">Turned off: password only</Badge>
            )}
          </Row>
          <Row label="Team members">{s.security.members}</Row>
          <Row label="Haven’t set up two-factor" hint="They set it up at their next sign-in.">
            <People people={s.security.withoutTwoFactor} none="Everyone has" />
          </Row>
          <Row label="Locked after too many wrong codes" hint="Unlock with Reset two-factor under Users.">
            <People people={s.security.locked} none="None" danger />
          </Row>
          <Row label="Secure cookies" hint="Sign-in and chat cookies are only sent over HTTPS.">
            {s.security.secureCookies ? <Badge variant="success">On</Badge> : <Badge variant="danger">Off (development)</Badge>}
          </Row>
        </Section>

        <Section title="Visitors and network">
          <Row label="Your IP, as the app sees it" hint="Rate limits are counted per IP.">
            <Code>{s.network.yourIp}</Code>
          </Row>
          <Row label="Trusted proxies" setting={s.network.clientIpHeader ? 'CLIENT_IP_HEADER' : 'TRUST_PROXY_HOPS'}>
            {s.network.clientIpHeader ? (
              <Code>{s.network.clientIpHeader}</Code>
            ) : s.network.trustedProxyHops > 0 ? (
              `${s.network.trustedProxyHops} ${s.network.trustedProxyHops === 1 ? 'proxy' : 'proxies'}`
            ) : (
              <Muted>None (visitors connect directly)</Muted>
            )}
          </Row>
          {s.network.warning && (
            <p role="alert" className="border-b border-border bg-destructive/5 px-5 py-3 text-sm text-destructive last:border-b-0">
              {s.network.warning}
            </p>
          )}
          <Row label="Sites that can embed the chat" setting="WIDGET_FRAME_ANCESTORS">
            {s.network.widgetFrameAncestors === "'self'" ? <Muted>Only this site</Muted> : <Code>{s.network.widgetFrameAncestors}</Code>}
          </Row>
        </Section>

        <Section title="Content and retention">
          <Row label="Data folder" setting="DATA_DIR">
            <Code>{s.content.dataDir}</Code>
          </Row>
          <Row label="Help articles (public)">{s.content.publicFiles}</Row>
          <Row label="Internal notes (private)">{s.content.privateFiles}</Row>
          <Row label="Archived conversations are deleted" setting="ARCHIVE_RETENTION_HOURS">
            {s.content.archiveRetentionHours > 0 ? `${hours(s.content.archiveRetentionHours)} after archiving` : <Muted>Never (kept until restored)</Muted>}
          </Row>
          <Row label="A visitor’s chat is remembered" setting="VISITOR_COOKIE_DAYS">
            {s.content.visitorCookieDays > 0
              ? `${s.content.visitorCookieDays} ${s.content.visitorCookieDays === 1 ? 'day' : 'days'} after their last message`
              : 'Until they close the browser'}
          </Row>
        </Section>

        <Section title="About this install">
          <Row label="Version">
            <Code>{s.app.version}</Code>
          </Row>
          <Row label="Node.js">
            <Code>{s.app.node}</Code>
          </Row>
          <Row label="Database" setting="DATABASE_PATH">
            <span className="text-right">
              <Code>{s.app.databasePath}</Code>
              <span className="block text-xs text-muted-foreground">
                {(s.app.databaseBytes / 1024).toFixed(0)} KB, schema version {s.app.schemaVersion}
              </span>
            </span>
          </Row>
          <Row label="Look and brand" setting="SUPPORT_CONFIG">
            <span className="text-right">
              <Code>{s.app.configPath}</Code>
              <span className="block text-xs text-muted-foreground">
                “{s.app.brandName}”, {s.app.customLogo ? 'custom logo' : 'default mark'}
              </span>
            </span>
          </Row>
        </Section>
      </div>
    </>
  )
}


// One setting: what it is on the left (with the env variable that controls
// it), its value on the right.
function Row({ label, hint, setting, children }: { label: string; hint?: string; setting?: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-1 border-b border-border px-5 py-3 text-sm last:border-b-0">
      <div className="min-w-0">
        <p>{label}</p>
        {(hint || setting) && (
          <p className="mt-0.5 text-xs text-muted-foreground">
            {hint}
            {hint && setting && ' '}
            {setting && <span className="font-mono">{setting}</span>}
          </p>
        )}
      </div>
      <div className="min-w-0 text-right [overflow-wrap:anywhere]">{children}</div>
    </div>
  )
}

function Code({ children }: { children: ReactNode }) {
  return <span className="font-mono text-xs">{children}</span>
}

function Muted({ children }: { children: ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>
}

function People({ people, none, danger }: { people: Array<{ name: string; email: string }>; none: string; danger?: boolean }) {
  if (!people.length) return <Muted>{none}</Muted>
  return (
    <span className={cn('block text-right', danger && 'text-destructive')}>
      {people.map((p) => (
        <span key={p.email} className="block" title={p.email}>
          {p.name}
        </span>
      ))}
    </span>
  )
}

// "12 of 60" with a thin bar; turns red when it's nearly used up.
function Usage({ used, max, nf }: { used: number; max: number; nf: Intl.NumberFormat }) {
  if (max === 0) return <Muted>No limit</Muted>
  const share = Math.min(1, used / max)
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <span>
        {nf.format(used)} of {nf.format(max)}
      </span>
      <span className="h-1 w-32 overflow-hidden rounded-full bg-muted" aria-hidden="true">
        <span className={cn('block h-full rounded-full', share >= 0.9 ? 'bg-destructive' : 'bg-primary')} style={{ width: `${share * 100}%` }} />
      </span>
    </span>
  )
}

// A month of AI answers as ModelRiver counts (and bills) them, with earlier months.
function UsageSection({ initial, since }: { initial: Data['usage']; since: string }) {
  const fetchUsage = useServerFn(getMonthUsage)
  const [view, setView] = useState(initial)
  const [busy, setBusy] = useState(false)
  const nf = new Intl.NumberFormat('en')
  const u = view.usage

  const load = async (month: string, refresh: boolean) => {
    setBusy(true)
    try {
      setView(await fetchUsage({ data: { month, refresh } }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section
      title="AI answers"
      description="Counted by ModelRiver for this install’s API key, the same way it bills them: one per AI answer. Replies from your team aren’t counted."
    >
      <div className="flex flex-wrap items-start gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0 flex-1">
          {u ? (
            <>
              <p className="text-2xl font-semibold tabular-nums">{nf.format(u.billable_requests)}</p>
              <p className="text-sm text-muted-foreground">AI answers in {monthLabel(view.month)}</p>
            </>
          ) : (
            <p className="font-medium">No usage to show for {monthLabel(view.month)}</p>
          )}
          {view.error && (
            <div className="mt-2">
              <Notice tone="error">
                Couldn’t refresh: {view.error}
                {view.fetchedAt && (
                  <>
                    {' '}
                    Showing the numbers from <RelativeTime iso={view.fetchedAt} />.
                  </>
                )}
              </Notice>
            </div>
          )}
          {!view.error && view.fetchedAt && (
            <p className="mt-1 text-xs text-muted-foreground">
              Updated <RelativeTime iso={view.fetchedAt} />
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Select aria-label="Month" value={view.month} disabled={busy} onChange={(e) => void load(e.target.value, false)}>
            {recentMonths(initial.month, since).map((m) => (
              <option key={m} value={m}>
                {monthLabel(m)}
              </option>
            ))}
          </Select>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void load(view.month, true)}>
            <BusyIcon busy={busy} size={14} idle={<RefreshIcon size={14} />} />
            Refresh
          </Button>
        </div>
      </div>
      {u && (
        <>
          <DayBars days={u.by_day} nf={nf} />
          <Row label="All requests" hint="Including test runs and the Playground.">
            {nf.format(u.requests)}
          </Row>
          <Row label="Failed requests">{nf.format(u.failed_requests)}</Row>
          <Row label="Conversations" hint="With at least one AI answer this month.">
            {nf.format(u.active_sessions)}
          </Row>
          <Row label="Tokens">{nf.format(u.total_tokens)}</Row>
          <Row label="Estimated model cost" hint="From ModelRiver’s model prices.">
            ${u.price.toFixed(2)}
          </Row>
        </>
      )}
    </Section>
  )
}

// AI answers per day as small bars; each bar's tooltip has the count.
function DayBars({ days, nf }: { days: Array<{ date: string; billable_requests: number }>; nf: Intl.NumberFormat }) {
  const max = Math.max(0, ...days.map((d) => d.billable_requests))
  if (max === 0) return null
  return (
    <div className="flex h-16 items-end gap-0.5 border-b border-border px-5 py-3" aria-hidden="true">
      {days.map((d) => (
        <span
          key={d.date}
          title={`${d.date}: ${nf.format(d.billable_requests)}`}
          className="min-w-0 flex-1 rounded-sm bg-primary"
          style={{ height: `${Math.max(4, (d.billable_requests / max) * 100)}%`, opacity: d.billable_requests ? 1 : 0.15 }}
        />
      ))}
    </div>
  )
}

// "2026-10" -> "October 2026"
function monthLabel(month: string): string {
  return new Date(`${month}-01T00:00:00Z`).toLocaleString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' })
}

// From `latest` back to the month the install was set up, newest first, and
// at most the 24 earlier months ModelRiver reports.
function recentMonths(latest: string, since: string): string[] {
  const [year, month] = latest.split('-').map(Number) as [number, number]
  const months: string[] = []
  for (let i = 0; i <= 24; i++) {
    const m = new Date(Date.UTC(year, month - 1 - i, 1)).toISOString().slice(0, 7)
    if (i > 0 && m < since) break
    months.push(m)
  }
  return months
}

function hours(h: number): string {
  if (h % 24 === 0) return `${h / 24} ${h === 24 ? 'day' : 'days'}`
  return `${h} ${h === 1 ? 'hour' : 'hours'}`
}

// Which email provider is set up, what's missing, and a test send.
function EmailSection({ email, onSent }: { email: Data['email']; onSent: () => void }) {
  const test = useServerFn(sendTestEmail)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)

  const status = !email.provider
    ? { label: 'Not set up', ok: false, detail: 'No emails are sent. Set EMAIL_PROVIDER to resend, postmark, ses or log, and EMAIL_FROM, then restart.' }
    : !email.ready
      ? { label: `${email.label}: incomplete`, ok: false, detail: `Missing ${email.missing.join(', ')}.` }
      : { label: email.label, ok: true, detail: email.provider === 'log' ? 'Emails are written to the server log instead of being sent.' : `Sending from ${email.from}.` }

  return (
    <Section title="Email" description="Sends team notifications. Each person chooses theirs in Account settings.">
      <div className="flex flex-wrap items-start gap-3 border-b border-border px-5 py-4">
        <span className={cn('mt-1.5 size-2.5 shrink-0 rounded-full', status.ok ? 'bg-success' : 'bg-muted-foreground/50')} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">{status.label}</p>
          <p className="mt-0.5 text-sm text-muted-foreground">{status.detail}</p>
          {result && (
            <div className="mt-2">
              <Notice tone={result.ok ? 'success' : 'error'}>{result.text}</Notice>
            </div>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={!email.ready || busy}
          onClick={async () => {
            setBusy(true)
            setResult(null)
            try {
              const res = await test()
              setResult({ ok: true, text: `Test email sent to ${res.sentTo}.` })
            } catch (err) {
              setResult({ ok: false, text: errorMessage(err, 'The test email failed.') })
            } finally {
              // Refresh "Last email" either way.
              onSent()
              setBusy(false)
            }
          }}
        >
          <BusyIcon busy={busy} size={14} />
          Send a test email
        </Button>
      </div>
      <Row label="Provider" setting="EMAIL_PROVIDER">
        {email.provider ? <Code>{email.provider}</Code> : <Muted>Not set</Muted>}
      </Row>
      <Row label="Sender" setting="EMAIL_FROM">
        {email.from ? <Code>{email.from}</Code> : <Muted>Not set</Muted>}
      </Row>
      <Row label="Links in emails" hint="The address people use to open this app." setting="APP_URL">
        {email.appUrl ? <Code>{email.appUrl}</Code> : <Muted>Not set, so emails have no links</Muted>}
      </Row>
      <Row label="Who gets notified">
        <span className="text-right">
          {email.handoffSubscribers} for people waiting
          <span className="block">{email.conversationSubscribers} for every new conversation</span>
        </span>
      </Row>
      <Row label="Last email" hint="Since the server started.">
        {email.last ? (
          <span className="text-right">
            {email.last.ok ? 'Sent' : <span className="text-destructive">Failed</span>} <RelativeTime iso={email.last.at} />
            {email.last.error && <span className="block text-xs text-destructive">{email.last.error}</span>}
          </span>
        ) : (
          <Muted>None yet</Muted>
        )}
      </Row>
    </Section>
  )
}
