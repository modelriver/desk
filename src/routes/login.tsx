import { useEffect, useState } from 'react'
import { createFileRoute, getRouteApi, Link, redirect, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { completeTwoFactorSetup, getMe, signIn, verifyTwoFactorCode } from '../functions/users.ts'
import { CopyIcon, ExternalIcon } from '../components/icons.tsx'
import { BrandMark } from '../components/BrandMark.tsx'
import { Button, Checkbox, Input, Label, Notice } from '../components/ui.tsx'
import { OtpInput } from '../components/OtpInput.tsx'
import { BusyIcon } from '../components/BusyIcon.tsx'
import { errorMessage } from '../lib/errors.ts'

const root = getRouteApi('__root__')

export const Route = createFileRoute('/login')({
  beforeLoad: async () => {
    if (await getMe()) throw redirect({ to: '/dashboard' })
  },
  head: () => ({ meta: [{ title: 'Sign in' }, { name: 'robots', content: 'noindex, nofollow' }] }),
  headers: () => ({ 'X-Robots-Tag': 'noindex, nofollow' }),
  component: Login,
})

type Step =
  | { kind: 'password' }
  | { kind: 'code' }
  | { kind: 'setup'; secret: string; otpauthUrl: string; qrDataUrl: string; account: string }
  | { kind: 'recovery-codes'; codes: string[] }
  | { kind: 'recovery-used'; left: number }

// Errors that mean the half-finished sign-in is gone (or the account is
// locked); start again at the password.
const RESTART = /email and password again|account is locked/

function Login() {
  const router = useRouter()
  const { brandName, logo } = root.useLoaderData()
  const [step, setStep] = useState<Step>({ kind: 'password' })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Moving to another screen clears the previous screen's error.
  const goTo = (next: Step) => {
    setError(null)
    setStep(next)
  }

  const enterDashboard = async () => {
    await router.invalidate()
    await router.navigate({ to: '/dashboard' })
  }

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (err) {
      const message = errorMessage(err, 'Sign in failed.')
      // Sent back to the password step: keep the message, it says why.
      if (RESTART.test(message)) setStep({ kind: 'password' })
      setError(message)
    } finally {
      setBusy(false)
    }
  }

  const heading = {
    password: { title: `Sign in to ${brandName}`, sub: 'For the support team. Visitors don’t need an account.' },
    code: { title: 'Two-factor authentication', sub: 'Enter the code from your authenticator app.' },
    setup: { title: 'Set up two-factor authentication', sub: 'Required for every team account. It takes about a minute.' },
    'recovery-codes': { title: 'Save your recovery codes', sub: 'Each one signs you in once if you lose your phone.' },
    'recovery-used': { title: 'Recovery code used', sub: 'You’re signed in.' },
  }[step.kind]

  return (
    <main className="grid min-h-dvh place-items-center bg-muted/40 px-4 py-10">
      <div className={step.kind === 'setup' || step.kind === 'recovery-codes' ? 'w-full max-w-md' : 'w-full max-w-sm'}>
        <div className="mb-6 flex flex-col items-center text-center">
          {/* No name beside it here, so the logo carries it as alt text. */}
          <BrandMark logo={logo} size={36} alt={brandName} />
          <h1 className="mt-4 text-lg font-semibold tracking-tight">{heading.title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{heading.sub}</p>
        </div>

        <div className="grid gap-4 rounded-xl border border-border bg-card p-6">
          {step.kind === 'password' && <PasswordStep busy={busy} error={error} run={run} onNext={goTo} onSignedIn={() => void enterDashboard()} />}
          {step.kind === 'code' && (
            <CodeStep
              busy={busy}
              error={error}
              onModeChange={() => setError(null)}
              onSubmit={(code) =>
                run(async () => {
                  const res = await verifyTwoFactorCode({ data: { code } })
                  if (res.usedRecoveryCode) goTo({ kind: 'recovery-used', left: res.recoveryCodesLeft })
                  else await enterDashboard()
                })
              }
            />
          )}
          {step.kind === 'setup' && (
            <SetupStep
              step={step}
              busy={busy}
              error={error}
              onSubmit={(code) =>
                run(async () => {
                  const res = await completeTwoFactorSetup({ data: { code } })
                  goTo({ kind: 'recovery-codes', codes: res.recoveryCodes })
                })
              }
            />
          )}
          {step.kind === 'recovery-codes' && <RecoveryCodes codes={step.codes} brandName={brandName} onDone={enterDashboard} />}
          {step.kind === 'recovery-used' && (
            <>
              <p className="text-sm">
                {step.left === 0
                  ? 'That was your last recovery code. Ask an admin to reset your two-factor authentication so you can set it up again.'
                  : `You have ${step.left} recovery ${step.left === 1 ? 'code' : 'codes'} left. If you’ve lost your phone, ask an admin to reset your two-factor authentication.`}
              </p>
              <Button onClick={() => void enterDashboard()}>Continue to dashboard</Button>
            </>
          )}
        </div>

        <p className="mt-6 text-center text-sm text-muted-foreground">
          {step.kind === 'code' || step.kind === 'setup' ? (
            <button type="button" className="cursor-pointer hover:text-foreground" onClick={() => goTo({ kind: 'password' })}>
              Use a different account
            </button>
          ) : (
            <Link to="/" className="hover:text-foreground">
              Back to the help center
            </Link>
          )}
        </p>
      </div>
    </main>
  )
}

function PasswordStep({
  busy,
  error,
  run,
  onNext,
  onSignedIn,
}: {
  busy: boolean
  error: string | null
  run: (fn: () => Promise<void>) => Promise<void>
  onNext: (step: Step) => void
  onSignedIn: () => void
}) {
  const login = useServerFn(signIn)
  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        const form = new FormData(e.currentTarget)
        void run(async () => {
          const res = await login({ data: { email: String(form.get('email')), password: String(form.get('password')) } })
          // Two-factor is turned off on this server (DISABLE_TWO_FACTOR).
          if (res.step === 'done') return onSignedIn()
          onNext(
            res.step === 'code'
              ? { kind: 'code' }
              : { kind: 'setup', secret: res.secret, otpauthUrl: res.otpauthUrl, qrDataUrl: res.qrDataUrl, account: res.account },
          )
        })
      }}
    >
      <Label>
        Email
        <Input name="email" type="email" autoComplete="username" required autoFocus />
      </Label>
      <Label>
        Password
        <Input name="password" type="password" autoComplete="current-password" required />
      </Label>
      {error && <Notice tone="error">{error}</Notice>}
      <Button type="submit" disabled={busy} className="mt-1 w-full">
        <BusyIcon busy={busy} size={15} />
        {busy ? 'Checking…' : 'Continue'}
      </Button>
    </form>
  )
}

// Clears the code boxes after a failed attempt so the next code can be typed.
function useResetOnError(error: string | null) {
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (error) setAttempt((a) => a + 1)
  }, [error])
  return attempt
}

function CodeStep({
  busy,
  error,
  onSubmit,
  onModeChange,
}: {
  busy: boolean
  error: string | null
  onSubmit: (code: string) => void
  onModeChange: () => void
}) {
  const [useRecovery, setUseRecovery] = useState(false)
  const [code, setCode] = useState('')
  const attempt = useResetOnError(error)
  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        if (code.trim()) onSubmit(code)
      }}
    >
      {useRecovery ? (
        <Label>
          Recovery code
          <Input
            key="recovery"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoComplete="off"
            autoFocus
            spellCheck={false}
            placeholder="xxxx-xxxx-xxxx"
            className="text-center font-mono"
          />
        </Label>
      ) : (
        <div className="grid gap-2">
          <p className="text-center text-sm font-medium">Enter the 6-digit code</p>
          <OtpInput
            key={`totp-${attempt}`}
            label="6-digit code from your authenticator app"
            autoFocus
            disabled={busy}
            invalid={!!error}
            onChange={setCode}
            onComplete={onSubmit}
          />
        </div>
      )}
      {error && (
        <p role="alert" className="text-center text-sm text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" disabled={busy || (useRecovery ? !code.trim() : code.length !== 6)} className="w-full">
        <BusyIcon busy={busy} size={15} />
        {busy ? 'Verifying…' : 'Verify'}
      </Button>
      <button
        type="button"
        className="cursor-pointer text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        onClick={() => {
          setUseRecovery(!useRecovery)
          setCode('')
          onModeChange()
        }}
      >
        {useRecovery ? 'Use a code from your authenticator app' : 'Lost your phone? Use a recovery code'}
      </button>
    </form>
  )
}

function SetupStep({
  step,
  busy,
  error,
  onSubmit,
}: {
  step: Extract<Step, { kind: 'setup' }>
  busy: boolean
  error: string | null
  onSubmit: (code: string) => void
}) {
  const [code, setCode] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [copied, setCopied] = useState(false)
  const attempt = useResetOnError(error)
  const groups = step.secret.match(/.{1,4}/g) ?? [step.secret]
  return (
    <form
      className="grid gap-6"
      onSubmit={(e) => {
        e.preventDefault()
        if (code.length === 6) onSubmit(code)
      }}
    >
      <ol className="grid gap-6 text-sm">
        <li className="flex gap-3">
          <StepNumber n={1} />
          <p className="pt-0.5">
            Open an authenticator app, such as Google Authenticator, 1Password or Authy.
          </p>
        </li>
        <li className="flex gap-3">
          <StepNumber n={2} />
          <div className="min-w-0 flex-1 pt-0.5">
            <p>
              Scan this QR code to add <span className="font-medium">{step.account}</span>.
            </p>
            <div className="mt-3 flex justify-center">
              {/* Always black on white: dark-mode inverted codes don't scan everywhere. */}
              <img
                src={step.qrDataUrl}
                alt={`QR code to add ${step.account} to an authenticator app`}
                width={176}
                height={176}
                className="rounded-lg border border-border bg-white p-1"
              />
            </div>
            <div className="mt-3 text-center">
              {showKey ? (
                <div className="text-left">
                  <p className="text-xs text-muted-foreground">Enter this setup key in the app (time-based):</p>
                  <div className="mt-2 flex items-start gap-2 rounded-lg border border-border bg-muted/50 p-2.5">
                    <code className="grid min-w-0 flex-1 grid-cols-4 gap-x-3 gap-y-1 font-mono text-[13px] select-all">
                      {groups.map((g, i) => (
                        <span key={i}>{g}</span>
                      ))}
                    </code>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Copy setup key"
                      onClick={() => {
                        void navigator.clipboard?.writeText(step.secret).then(() => setCopied(true))
                      }}
                    >
                      <CopyIcon size={14} />
                    </Button>
                  </div>
                  {copied && <p className="mt-1 text-xs text-success">Copied.</p>}
                  <a href={step.otpauthUrl} className="mt-2 inline-flex items-center gap-1.5 text-xs text-primary underline-offset-4 hover:underline">
                    <ExternalIcon size={12} />
                    On this phone? Open in your authenticator app
                  </a>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowKey(true)}
                  className="cursor-pointer text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                >
                  Can’t scan it? Enter a setup key instead
                </button>
              )}
            </div>
          </div>
        </li>
        <li className="flex gap-3">
          <StepNumber n={3} />
          <div className="min-w-0 flex-1 pt-0.5">
            <p className="mb-3">Enter the 6-digit code the app shows.</p>
            <OtpInput
              key={`setup-${attempt}`}
              label="6-digit code from your authenticator app"
              disabled={busy}
              invalid={!!error}
              onChange={setCode}
              onComplete={onSubmit}
            />
          </div>
        </li>
      </ol>
      {error && (
        <p role="alert" className="text-center text-sm text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" disabled={busy || code.length !== 6} className="w-full">
        <BusyIcon busy={busy} size={15} />
        {busy ? 'Checking…' : 'Turn on two-factor authentication'}
      </Button>
    </form>
  )
}

function StepNumber({ n }: { n: number }) {
  return (
    <span className="grid size-6 shrink-0 place-items-center rounded-full bg-muted text-xs font-semibold text-muted-foreground" aria-hidden="true">
      {n}
    </span>
  )
}

function RecoveryCodes({ codes, brandName, onDone }: { codes: string[]; brandName: string; onDone: () => Promise<void> }) {
  const [saved, setSaved] = useState(false)
  const [copied, setCopied] = useState(false)
  const text = `${brandName} recovery codes\nEach code works once.\n\n${codes.join('\n')}\n`
  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted-foreground">
        Keep these somewhere safe, like a password manager. They won’t be shown again.
      </p>
      <ul className="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-lg border border-border bg-muted/50 px-4 py-3 font-mono text-sm">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void navigator.clipboard?.writeText(text).then(() => setCopied(true))
          }}
        >
          <CopyIcon size={14} />
          {copied ? 'Copied' : 'Copy codes'}
        </Button>
        <a
          href={`data:text/plain;charset=utf-8,${encodeURIComponent(text)}`}
          download="recovery-codes.txt"
          className="inline-flex h-8 items-center gap-2 rounded-md border border-input bg-card px-3 text-[13px] font-medium hover:bg-muted"
        >
          Download .txt
        </a>
      </div>
      <label className="flex cursor-pointer items-center gap-2.5 text-sm">
        <Checkbox checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        I’ve saved my recovery codes
      </label>
      <Button disabled={!saved} onClick={() => void onDone()} className="w-full">
        Continue to dashboard
      </Button>
    </div>
  )
}
