import { env } from './env.server.ts'
import { signAwsRequest } from './aws-sigv4.server.ts'
import { errorMessage } from '../lib/errors.ts'

// Sending email through whichever provider EMAIL_PROVIDER names. Every
// provider is one HTTPS call with fetch, so there's no SDK to install. To add
// another, write a function with the same shape and add it to PROVIDERS.

export interface Email {
  to: string
  subject: string
  text: string
  html: string
  // Where the recipient's reply goes (ticket replies: SUPPORT_REPLY_TO).
  replyTo?: string
  // Extra headers, such as In-Reply-To and References so a ticket's emails
  // stay in one thread (see ticketThreadHeaders).
  headers?: Record<string, string>
}

const headerList = (headers: Record<string, string> | undefined) => Object.entries(headers ?? {}).map(([Name, Value]) => ({ Name, Value }))

export type EmailProvider = 'resend' | 'postmark' | 'ses' | 'log'

type Send = (email: Email, from: string) => Promise<void>

class EmailError extends Error {}

async function check(res: Response, provider: string) {
  if (res.ok) return
  const body = await res.text().catch(() => '')
  throw new EmailError(`${provider} refused the email (${res.status}): ${body.slice(0, 200)}`)
}

const PROVIDERS: Record<EmailProvider, { label: string; settings: string[]; send: Send }> = {
  resend: {
    label: 'Resend',
    settings: ['RESEND_API_KEY'],
    send: async (email, from) => {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from,
          to: [email.to],
          subject: email.subject,
          text: email.text,
          html: email.html,
          ...(email.replyTo ? { reply_to: email.replyTo } : {}),
          ...(email.headers ? { headers: email.headers } : {}),
        }),
        signal: AbortSignal.timeout(15_000),
      })
      await check(res, 'Resend')
    },
  },
  postmark: {
    label: 'Postmark',
    settings: ['POSTMARK_SERVER_TOKEN'],
    send: async (email, from) => {
      const res = await fetch('https://api.postmarkapp.com/email', {
        method: 'POST',
        headers: {
          'X-Postmark-Server-Token': process.env.POSTMARK_SERVER_TOKEN ?? '',
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          From: from,
          To: email.to,
          Subject: email.subject,
          TextBody: email.text,
          HtmlBody: email.html,
          ...(email.replyTo ? { ReplyTo: email.replyTo } : {}),
          ...(email.headers ? { Headers: headerList(email.headers) } : {}),
          MessageStream: 'outbound',
        }),
        signal: AbortSignal.timeout(15_000),
      })
      await check(res, 'Postmark')
    },
  },
  ses: {
    label: 'Amazon SES',
    settings: ['AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'],
    send: async (email, from) => {
      const region = process.env.AWS_REGION ?? ''
      const url = `https://email.${region}.amazonaws.com/v2/email/outbound-emails`
      const body = JSON.stringify({
        FromEmailAddress: from,
        Destination: { ToAddresses: [email.to] },
        ...(email.replyTo ? { ReplyToAddresses: [email.replyTo] } : {}),
        Content: {
          Simple: {
            Subject: { Data: email.subject, Charset: 'UTF-8' },
            Body: { Text: { Data: email.text, Charset: 'UTF-8' }, Html: { Data: email.html, Charset: 'UTF-8' } },
            ...(email.headers ? { Headers: headerList(email.headers) } : {}),
          },
        },
      })
      const headers = signAwsRequest({
        method: 'POST',
        url,
        headers: { 'content-type': 'application/json' },
        body,
        region,
        service: 'ses',
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? '',
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? '',
          sessionToken: process.env.AWS_SESSION_TOKEN || undefined,
        },
      })
      const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(15_000) })
      await check(res, 'Amazon SES')
    },
  },
  // For development: prints the email to the server log instead of sending it.
  log: {
    label: 'Server log (development)',
    settings: [],
    send: async (email, from) => {
      const headers = Object.entries(email.headers ?? {}).map(([k, v]) => `${k}: ${v}\n`).join('')
      console.log(`[email] from ${from} to ${email.to}${email.replyTo ? ` (replies to ${email.replyTo})` : ''}: ${email.subject}\n${headers}${email.text}`)
    },
  },
}

export interface EmailStatus {
  provider: EmailProvider | null
  label: string
  from: string
  // Settings the chosen provider needs that aren't set.
  missing: string[]
  ready: boolean
}

// What's configured, without revealing any keys.
export function emailStatus(): EmailStatus {
  const name = env.emailProvider
  if (!name) return { provider: null, label: 'Not set up', from: env.emailFrom, missing: [], ready: false }
  const provider = PROVIDERS[name]
  const missing = provider.settings.filter((s) => !process.env[s])
  if (!env.emailFrom && name !== 'log') missing.unshift('EMAIL_FROM')
  return { provider: name, label: provider.label, from: env.emailFrom, missing, ready: missing.length === 0 }
}

let lastResult: { at: string; ok: boolean; error?: string } | null = null

export function lastEmailResult() {
  return lastResult
}

// Sends one email, or throws with a message an admin can act on.
export async function sendEmail(email: Email): Promise<void> {
  const status = emailStatus()
  if (!status.provider) throw new EmailError('Email isn’t set up. Set EMAIL_PROVIDER and restart.')
  if (!status.ready) throw new EmailError(`Email isn’t fully set up: ${status.missing.join(', ')} missing.`)
  try {
    await PROVIDERS[status.provider].send(email, env.emailFrom || 'Support <support@localhost>')
    lastResult = { at: new Date().toISOString(), ok: true }
  } catch (err) {
    const error = err instanceof EmailError ? err.message : `Couldn’t reach ${status.label}: ${errorMessage(err, 'unknown error')}`
    lastResult = { at: new Date().toISOString(), ok: false, error }
    throw new EmailError(error)
  }
}
