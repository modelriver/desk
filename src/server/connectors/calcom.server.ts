import { parseHttpsUrl } from '../safe-http.server.ts'
import {
  ConnectorError,
  asArray,
  asRecord,
  clean,
  expectOk,
  jsonObject,
  send,
  type Connector,
  type ConnectorConfig,
  type ConnectorDeps,
} from './types.ts'
import { errorMessage } from '../../lib/errors.ts'

// Cal.com: the visitor's upcoming bookings, with links to reschedule or
// cancel them on Cal.com (the visitor does that themselves; Desk only reads).
// Cal.com API keys can't be limited to reading, so Desk only ever sends GET
// requests with it. Works with cal.com or a self-hosted install.

const DEFAULT_API = 'https://api.cal.com'
const DEFAULT_APP = 'https://cal.com'
const API_VERSION = '2024-08-13'
const MAX_BOOKINGS = 5

function baseUrl(raw: string | undefined, fallback: string): string {
  const value = (raw ?? '').trim()
  if (!value) return fallback
  try {
    return parseHttpsUrl(value).toString().replace(/\/+$/, '')
  } catch (err) {
    throw new ConnectorError('error', errorMessage(err, 'Invalid URL.'))
  }
}

function validUrl(value: string): string | null {
  if (!value.trim()) return null
  try {
    parseHttpsUrl(value.trim())
    return null
  } catch (err) {
    return errorMessage(err, 'Invalid URL.')
  }
}

async function get(config: ConnectorConfig, deps: ConnectorDeps, path: string, params: Array<[string, string]> = []) {
  const api = baseUrl(config.values.api_url, DEFAULT_API)
  const qs = params.length ? `?${new URLSearchParams(params)}` : ''
  const res = await send(deps, 'Cal.com', {
    url: `${api}${path}${qs}`,
    headers: { Authorization: `Bearer ${config.values.api_key ?? ''}`, 'cal-api-version': API_VERSION },
    timeoutMs: 4_000,
    maxBytes: 256 * 1024,
    // Only a self-hosted Cal.com can be on your own network.
    allowPrivate: api !== DEFAULT_API && config.allowPrivate,
  })
  return jsonObject(expectOk(res, 'Cal.com'), 'Cal.com')
}

export function projectBooking(booking: unknown, appUrl: string, email: string) {
  const b = asRecord(booking)
  const uid = typeof b.uid === 'string' && /^[A-Za-z0-9_-]{4,64}$/.test(b.uid) ? b.uid : null
  const attendee = asRecord(asArray(b.attendees).find((a) => String(asRecord(a).email ?? '').toLowerCase() === email))
  const status = clean(b.status, 20)?.toLowerCase() ?? null
  const active = status !== 'cancelled' && status !== 'rejected'
  return {
    title: clean(b.title, 120),
    start: clean(b.start, 40),
    end: clean(b.end, 40),
    timeZone: clean(attendee.timeZone, 60),
    status,
    rescheduleLink: uid && active ? `${appUrl}/reschedule/${uid}` : null,
    cancelLink: uid && active ? `${appUrl}/booking/${uid}?cancel=true` : null,
  }
}

export const calcom: Connector = {
  id: 'calcom',
  label: 'Cal.com',
  description: 'The visitor’s upcoming bookings, with links to reschedule or cancel them.',
  setupUrl: 'https://app.cal.com/settings/developer/api-keys',
  fields: [
    {
      name: 'api_key',
      label: 'API key',
      secret: true,
      env: 'CALCOM_API_KEY',
      required: true,
      placeholder: 'cal_live_…',
      hint: 'Cal.com keys can’t be made read-only, so Desk only ever reads with it.',
      validate: (v) => (/^cal_[A-Za-z0-9_]{10,}$/.test(v.trim()) ? null : 'Cal.com API keys start with cal_.'),
    },
    {
      name: 'api_url',
      label: 'API address (self-hosted only)',
      secret: false,
      env: 'CALCOM_API_URL',
      required: false,
      placeholder: DEFAULT_API,
      validate: validUrl,
    },
    {
      name: 'app_url',
      label: 'Booking site (self-hosted only)',
      secret: false,
      env: 'CALCOM_APP_URL',
      required: false,
      placeholder: DEFAULT_APP,
      hint: 'Used for reschedule and cancel links.',
      validate: validUrl,
    },
  ],
  options: [{ name: 'include_links', label: 'Reschedule and cancel links', default: true }],
  topics: () => /\b(?:book(?:ing|ings|ed)?|appointments?|reschedul\w*|meetings?|sessions?|calls?|consultations?|slots?|cancel\w*|calendar)\b/i,

  async test(config, deps) {
    const body = await get(config, deps, '/v2/me')
    const me = asRecord(body.data)
    const who = clean(me.username ?? me.email, 80)
    return { ok: true, detail: who ? `Connected as ${who}.` : 'Connected.' }
  },

  async lookup(config, input, deps) {
    const appUrl = baseUrl(config.values.app_url, DEFAULT_APP)
    const body = await get(config, deps, '/v2/bookings', [
      ['attendeeEmail', input.email],
      ['status', 'upcoming'],
      ['take', String(MAX_BOOKINGS)],
    ])
    // Only bookings this email is really an attendee of.
    const bookings = asArray(body.data)
      .filter((b) => asArray(asRecord(b).attendees).some((a) => String(asRecord(a).email ?? '').toLowerCase() === input.email))
      .slice(0, MAX_BOOKINGS)
      .map((b) => {
        const booking = projectBooking(b, appUrl, input.email)
        if (config.options.include_links === false) return { ...booking, rescheduleLink: null, cancelLink: null }
        return booking
      })
    if (!bookings.length) return { status: 'not_found', summary: 'no upcoming bookings for this email' }
    return { status: 'ok', summary: `${bookings.length} upcoming booking${bookings.length === 1 ? '' : 's'}`, data: { bookings } }
  },
}
