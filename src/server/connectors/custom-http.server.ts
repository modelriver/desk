import { createHash, createHmac } from 'node:crypto'
import { parseHttpsUrl } from '../safe-http.server.ts'
import {
  ConnectorError,
  asArray,
  asRecord,
  clean,
  cleanUrl,
  expectOk,
  jsonObject,
  send,
  wordsPattern,
  type Connector,
  type ConnectorConfig,
  type ConnectorDeps,
} from './types.ts'
import { errorMessage } from '../../lib/errors.ts'

// Custom HTTP: your own API answers for everything without a ready-made
// connector. Desk sends one signed POST with the verified email (and, if you
// allow it, the question), and your API answers with a few facts:
//
//   { "facts": [{ "label": "Plan", "value": "Team, 12 seats" }, { "label": "Licence", "value": "Renews 2027-01-31", "url": "https://..." }] }
//   { "found": false }
//
// Verify X-Desk-Signature before answering: it is
// "sha256=" + hex(HMAC-SHA256(secret, X-Desk-Timestamp + "." + raw body)),
// and reject timestamps more than 5 minutes old. The README has an example.

const MAX_FACTS = 20
const MIN_SECRET = 32

export function signBody(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`
}

function validUrl(value: string): string | null {
  try {
    parseHttpsUrl(value.trim())
    return null
  } catch (err) {
    return errorMessage(err, 'Invalid URL.')
  }
}

function serviceName(config: ConnectorConfig): string {
  return clean(config.values.name, 40) ?? 'Your API'
}

async function post(config: ConnectorConfig, deps: ConnectorDeps, payload: Record<string, unknown>) {
  const secret = config.values.signing_secret ?? ''
  if (secret.length < MIN_SECRET) throw new ConnectorError('error', `The signing secret must be at least ${MIN_SECRET} characters.`)
  const now = deps.now?.() ?? new Date()
  const timestamp = String(Math.floor(now.getTime() / 1000))
  const body = JSON.stringify({ ...payload, sent_at: now.toISOString() })
  const res = await send(deps, serviceName(config), {
    url: parseHttpsUrl((config.values.url ?? '').trim()).toString(),
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Desk-Timestamp': timestamp, 'X-Desk-Signature': signBody(secret, timestamp, body) },
    body,
    timeoutMs: 4_000,
    allowPrivate: config.allowPrivate,
  })
  return jsonObject(expectOk(res, serviceName(config)), serviceName(config))
}

export function projectFacts(body: Record<string, unknown>) {
  return asArray(body.facts)
    .slice(0, MAX_FACTS)
    .map((f) => {
      const fact = asRecord(f)
      return { label: clean(fact.label, 80), value: clean(fact.value, 300), url: cleanUrl(fact.url) }
    })
    .filter((f) => f.label && f.value)
}

export const customHttp: Connector = {
  id: 'custom_http',
  label: 'Custom HTTP',
  description: 'Your own API, for anything without a ready-made connector. Desk sends a signed request; your API decides what to share.',
  setupUrl: 'https://github.com/modelriver/desk#custom-http',
  fields: [
    {
      name: 'url',
      label: 'Endpoint URL',
      secret: false,
      env: 'CUSTOM_HTTP_URL',
      required: true,
      placeholder: 'https://api.example.com/desk/lookup',
      validate: validUrl,
    },
    {
      name: 'signing_secret',
      label: 'Signing secret',
      secret: true,
      env: 'CUSTOM_HTTP_SECRET',
      required: true,
      hint: 'At least 32 characters, shared with your API. Generate one with openssl rand -base64 32.',
      validate: (v) => (v.trim().length >= MIN_SECRET ? null : `Use at least ${MIN_SECRET} characters.`),
    },
    {
      name: 'name',
      label: 'Name shown to visitors and the AI',
      secret: false,
      env: 'CUSTOM_HTTP_NAME',
      required: false,
      placeholder: 'Account system',
      validate: (v) => (v.trim().length <= 40 ? null : 'Keep it under 40 characters.'),
    },
    {
      name: 'topics',
      label: 'When to ask it',
      secret: false,
      env: 'CUSTOM_HTTP_TOPICS',
      required: false,
      placeholder: 'licence, seats, account',
      hint: 'Words, separated by commas. Empty: every question from a verified visitor.',
      validate: (v) => (v.length <= 500 ? null : 'Keep the list under 500 characters.'),
    },
  ],
  options: [{ name: 'send_question', label: 'Send the visitor’s question too', hint: 'Off: only their email is sent.', default: true }],
  displayName: (config) => clean(config.values.name, 40) ?? 'Custom HTTP',
  topics: (config) => wordsPattern((config.values.topics ?? '').split(',')),

  async test(config, deps) {
    await post(config, deps, { type: 'test' })
    return { ok: true, detail: `${serviceName(config)} answered the signed test request.` }
  },

  // The question is sent, so the answer can depend on it.
  cacheKey: (config, input) =>
    config.options.send_question !== false ? createHash('sha256').update(input.question).digest('hex').slice(0, 16) : '',

  async lookup(config, input, deps) {
    const body = await post(config, deps, {
      type: 'lookup',
      email: input.email,
      conversation_id: input.conversationId,
      ...(config.options.send_question !== false ? { question: input.question } : {}),
    })
    if (body.found === false) return { status: 'not_found', summary: 'nothing found for this email' }
    const facts = projectFacts(body)
    if (!facts.length) return { status: 'not_found', summary: 'nothing found for this email' }
    return { status: 'ok', summary: `${facts.length} fact${facts.length === 1 ? '' : 's'}`, data: { facts } }
  },
}
