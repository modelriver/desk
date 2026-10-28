import { useId, useMemo, useState } from 'react'
import { createFileRoute, redirect } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { getIntegrations, saveIntegration, testIntegration, type IntegrationsData } from '../../functions/integrations.ts'
import { LoadError } from '../../components/LoadError.tsx'
import { ExternalIcon } from '../../components/icons.tsx'
import { Badge, Button, Card, Checkbox, Input, Notice, PageHeader, Section, Switch } from '../../components/ui.tsx'
import { RelativeTime } from '../../components/RelativeTime.tsx'
import { cn } from '../../lib/cn.ts'
import { BusyIcon } from '../../components/BusyIcon.tsx'
import { errorMessage } from '../../lib/errors.ts'

export const Route = createFileRoute('/dashboard/integrations')({
  beforeLoad: ({ context }) => {
    if (context.user.role !== 'admin') throw redirect({ to: '/dashboard' })
  },
  loader: () => getIntegrations(),
  errorComponent: ({ error }) => (
    <>
      <PageHeader title="Integrations" />
      <LoadError title="Couldn’t load integrations" error={error} />
    </>
  ),
  component: Integrations,
})

type Connector = IntegrationsData['connectors'][number]

function Integrations() {
  const loaded = Route.useLoaderData()
  const [data, setData] = useState<IntegrationsData>(loaded)
  const labels = useMemo(() => new Map(data.connectors.map((c) => [c.id, c.name])), [data.connectors])
  const canVerify = data.identity.emailCode || data.identity.token

  return (
    <>
      <PageHeader
        title="Integrations"
        description="Let the assistant look up a visitor’s own orders, billing or bookings, read-only, once they’ve proved their email. Keys are encrypted on this server and never shown again. Only admins see this page."
      />
      <div className="space-y-8">
        <Section
          title="Who can be looked up"
          description={`A visitor proves their email before any lookup. Without one of these, connectors stay unused. A verification lasts ${
            data.verification.hours > 0 ? `${data.verification.hours} hours` : 'until the conversation ends'
          }, or ${data.verification.idleHours} hours without a message, whichever comes first (VERIFIED_HOURS).`}
        >
          <Status
            ok={data.identity.emailCode}
            label="Email codes"
            detail={
              data.identity.emailCode
                ? 'Visitors can verify in the chat with a 6-digit code sent to their email.'
                : 'Needs email set up (EMAIL_PROVIDER and EMAIL_FROM; see Settings).'
            }
          />
          <Status
            ok={data.identity.token}
            label="Signed-in visitors"
            detail={
              data.identity.token
                ? 'Your site can pass a signed identity token to the widget, so signed-in visitors skip the code.'
                : 'Optional. Set DESK_IDENTITY_SECRET and sign tokens on your site (see the README).'
            }
          />
          {!data.secretKeySet && (
            <Status
              ok={false}
              label="Saving keys here"
              detail="Set DESK_SECRET_KEY on the server (openssl rand -base64 32) and restart to save keys on this page. Until then, keys can only come from the environment."
            />
          )}
          {!canVerify && (
            <p className="border-t border-border bg-muted/50 px-5 py-3 text-sm text-muted-foreground">
              Neither is set up yet, so connectors won’t be used in chats.
            </p>
          )}
        </Section>

        {data.connectors.map((c) => (
          <ConnectorCard key={c.id} connector={c} secretKeySet={data.secretKeySet} onSaved={setData} />
        ))}

        <Section title="Recent lookups" description="What the assistant looked up, for whom (masked) and what came back. No account data is kept. Kept for 30 days.">
          {data.events.length === 0 ? (
            <p className="px-5 py-4 text-sm text-muted-foreground">None yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr className="border-b border-border">
                    <th className="px-5 py-2 font-medium">When</th>
                    <th className="px-3 py-2 font-medium">Service</th>
                    <th className="px-3 py-2 font-medium">Visitor</th>
                    <th className="px-3 py-2 font-medium">Result</th>
                    <th className="px-5 py-2 font-medium">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {data.events.map((e, i) => (
                    <tr key={i} className="border-b border-border last:border-b-0">
                      <td className="px-5 py-2 whitespace-nowrap text-muted-foreground">
                        <RelativeTime iso={e.createdAt} />
                      </td>
                      <td className="px-3 py-2">{labels.get(e.connector) ?? e.connector}</td>
                      <td className="px-3 py-2 font-mono text-xs">{e.subject}</td>
                      <td className="px-3 py-2">
                        <ResultBadge status={e.status} />
                      </td>
                      <td className="px-5 py-2 text-muted-foreground">
                        {e.detail}
                        {e.latencyMs !== null && <span className="ml-1 text-xs">· {e.latencyMs} ms</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        <Section title="Changes" description="Who changed which connector settings.">
          {data.audit.length === 0 ? (
            <p className="px-5 py-4 text-sm text-muted-foreground">No changes yet.</p>
          ) : (
            data.audit.map((a, i) => (
              <div key={i} className="flex flex-wrap justify-between gap-x-6 border-b border-border px-5 py-2.5 text-sm last:border-b-0">
                <span>
                  {a.user} <span className="text-muted-foreground">{AUDIT_ACTIONS[a.action] ?? a.action}</span>{' '}
                  <span className="font-mono text-xs">{a.target}</span>
                </span>
                <span className="text-muted-foreground">
                  <RelativeTime iso={a.createdAt} />
                </span>
              </div>
            ))
          )}
        </Section>
      </div>
    </>
  )
}

const AUDIT_ACTIONS: Record<string, string> = {
  'connector.enabled': 'turned on',
  'connector.disabled': 'turned off',
  'connector.key_saved': 'saved the key',
  'connector.setting_saved': 'saved',
  'connector.field_cleared': 'removed',
}

function ResultBadge({ status }: { status: string }) {
  if (status === 'ok') return <Badge variant="success">Found</Badge>
  if (status === 'not_found') return <Badge variant="muted">Nothing found</Badge>
  if (status === 'rate_limited') return <Badge variant="danger">Paused</Badge>
  return <Badge variant="danger">Failed</Badge>
}

function ConnectorCard({
  connector: c,
  secretKeySet,
  onSaved,
}: {
  connector: Connector
  secretKeySet: boolean
  onSaved: (d: IntegrationsData) => void
}) {
  const save = useServerFn(saveIntegration)
  const test = useServerFn(testIntegration)
  const initialValues = () => Object.fromEntries(c.fields.map((f) => [f.name, f.secret ? '' : f.value]))
  const [values, setValues] = useState<Record<string, string>>(initialValues)
  const [options, setOptions] = useState<Record<string, boolean>>(() => Object.fromEntries(c.options.map((o) => [o.name, o.value])))
  const [busy, setBusy] = useState<'save' | 'test' | null>(null)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const titleId = useId()

  const changed = (f: Connector['fields'][number]) => (f.secret ? values[f.name] !== '' : values[f.name] !== f.value)

  const submit = async (enabled: boolean, clear: string[] = []) => {
    setBusy('save')
    setResult(null)
    try {
      // Only fields that changed are sent; an empty secret means "keep it".
      const sent = Object.fromEntries(c.fields.filter((f) => !clear.includes(f.name) && changed(f)).map((f) => [f.name, values[f.name] ?? '']))
      const next = await save({ data: { id: c.id, enabled, values: sent, clear, options } })
      onSaved(next)
      const updated = next.connectors.find((x) => x.id === c.id)
      if (updated) setValues(Object.fromEntries(updated.fields.map((f) => [f.name, f.secret ? '' : f.value])))
      setResult({ ok: true, text: enabled ? `${c.label} is on.` : 'Saved.' })
    } catch (err) {
      setResult({ ok: false, text: errorMessage(err, 'Couldn’t save.') })
    } finally {
      setBusy(null)
    }
  }

  const runTest = async () => {
    setBusy('test')
    setResult(null)
    try {
      const r = await test({ data: { id: c.id } })
      setResult({ ok: r.ok, text: r.detail })
    } catch (err) {
      setResult({ ok: false, text: errorMessage(err, 'The test failed.') })
    } finally {
      setBusy(null)
    }
  }

  const state = c.enabled && c.ready ? { label: 'On', variant: 'success' as const } : c.ready ? { label: 'Off', variant: 'muted' as const } : { label: 'Needs setup', variant: 'muted' as const }
  const dirty = c.fields.some(changed) || c.options.some((o) => options[o.name] !== o.value)

  return (
    <section aria-labelledby={titleId}>
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-start gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 id={titleId} className="font-semibold">
                {c.label}
              </h2>
              <Badge variant={state.variant}>{state.label}</Badge>
            </div>
            <p className="mt-0.5 text-sm text-muted-foreground">{c.description}</p>
            {c.problems.map((p) => (
              <p key={p} className="mt-1 text-sm text-destructive">
                {p}
              </p>
            ))}
          </div>
          <Switch
            checked={c.enabled}
            disabled={busy !== null}
            onChange={(next) => void submit(next)}
            aria-label={`Use ${c.label} in chats`}
            className="mt-1"
          />
        </div>

        <form
          className="grid gap-4 px-5 py-4"
          onSubmit={(e) => {
            e.preventDefault()
            void submit(c.enabled)
          }}
        >
          {c.fields.map((f) => (
            <FieldRow
              key={f.name}
              field={f}
              value={values[f.name] ?? ''}
              secretKeySet={secretKeySet}
              busy={busy !== null}
              onChange={(v) => setValues((prev) => ({ ...prev, [f.name]: v }))}
              // Without a required field it can't stay on.
              onClear={() => void submit(f.required ? false : c.enabled, [f.name])}
            />
          ))}
          {c.options.length > 0 && (
            <fieldset className="grid gap-2">
              <legend className="mb-1 text-sm font-medium">Share with the assistant</legend>
              {c.options.map((o) => (
                <label key={o.name} className="flex cursor-pointer items-start gap-2.5 text-sm">
                  <Checkbox
                    className="mt-0.5"
                    checked={options[o.name] ?? o.value}
                    onChange={(e) => setOptions((prev) => ({ ...prev, [o.name]: e.target.checked }))}
                  />
                  <span>
                    {o.label}
                    {o.hint && <span className="block text-xs text-muted-foreground">{o.hint}</span>}
                  </span>
                </label>
              ))}
            </fieldset>
          )}
          {result && <Notice tone={result.ok ? 'success' : 'error'}>{result.text}</Notice>}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" disabled={busy !== null || !dirty}>
              <BusyIcon busy={busy === 'save'} size={14} />
              Save
            </Button>
            <Button variant="outline" size="sm" disabled={busy !== null || !c.ready || dirty} onClick={() => void runTest()}>
              <BusyIcon busy={busy === 'test'} size={14} />
              Test connection
            </Button>
            <a
              href={c.setupUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-auto inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            >
              Where to get the key <ExternalIcon size={13} />
            </a>
          </div>
        </form>
      </Card>
    </section>
  )
}

function FieldRow({
  field: f,
  value,
  secretKeySet,
  busy,
  onChange,
  onClear,
}: {
  field: Connector['fields'][number]
  value: string
  secretKeySet: boolean
  busy: boolean
  onChange: (v: string) => void
  onClear: () => void
}) {
  const id = useId()
  const fromEnv = f.secret ? f.state.source === 'env' : f.fromEnv
  const saved = f.secret && f.state.source === 'dashboard'
  const locked = fromEnv || (f.secret && !secretKeySet)
  const placeholder = f.secret
    ? fromEnv
      ? `Set in the environment${f.state.last4 ? ` (ends in ${f.state.last4})` : ''}`
      : saved
        ? `Saved${f.state.last4 ? `, ends in ${f.state.last4}` : ''}. Enter a new one to replace it.`
        : !secretKeySet
          ? 'Needs DESK_SECRET_KEY to save here'
          : f.placeholder
    : fromEnv
      ? 'Set in the environment'
      : f.placeholder
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {f.label}
        {!f.required && <span className="font-normal text-muted-foreground"> (optional)</span>}
      </label>
      <div className="flex gap-2">
        <Input
          id={id}
          type={f.secret ? 'password' : 'text'}
          autoComplete="off"
          spellCheck={false}
          value={value}
          disabled={locked || busy}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className={cn('font-mono text-[13px]', f.secret && saved && 'placeholder:text-foreground/70')}
          aria-describedby={`${id}-hint`}
        />
        {(saved || (!f.secret && f.value && !fromEnv)) && (
          <Button variant="ghost-destructive" size="sm" disabled={busy} onClick={onClear}>
            Remove
          </Button>
        )}
      </div>
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        {f.hint}
        {f.hint && ' '}
        Or set <span className="font-mono">{f.env}</span>
        {fromEnv && ', which is what’s used now'}.
        {f.secret && f.state.stale && <span className="block text-destructive">Saved with a different DESK_SECRET_KEY: enter it again.</span>}
      </p>
    </div>
  )
}


function Status({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
  return (
    <div className="flex items-start gap-3 border-b border-border px-5 py-3 last:border-b-0">
      <span className={cn('mt-1.5 size-2.5 shrink-0 rounded-full', ok ? 'bg-success' : 'bg-muted-foreground/50')} aria-hidden="true" />
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        <p className="mt-0.5 text-sm text-muted-foreground">{detail}</p>
      </div>
    </div>
  )
}
