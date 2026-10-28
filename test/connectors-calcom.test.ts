import { test } from 'node:test'
import assert from 'node:assert/strict'
import { calcom } from '../src/server/connectors/calcom.server.ts'
import type { ConnectorConfig } from '../src/server/connectors/types.ts'
import { assertAbsent, failsWith, fakeHttp, path } from './connector-helpers.ts'

const KEY = 'cal_live_0123456789abcdef'
const config = (values: Record<string, string> = {}, options: Record<string, boolean> = {}, allowPrivate = false): ConnectorConfig => ({
  values: { api_key: KEY, ...values },
  options: { include_links: true, ...options },
  allowPrivate,
})
const input = { email: 'sam@example.com', question: 'when is my appointment?', conversationId: 'c1' }

const booking = (overrides: Record<string, unknown> = {}) => ({
  uid: 'abc123XYZ',
  title: 'Consultation with Dr. Lee',
  start: '2026-11-02T15:00:00.000Z',
  end: '2026-11-02T15:30:00.000Z',
  status: 'accepted',
  attendees: [{ email: 'sam@example.com', name: 'Sam', timeZone: 'Europe/London' }, { email: 'other@example.com', name: 'Other person' }],
  // Never shown to the AI:
  location: '221B Baker Street',
  responses: { notes: 'Private medical history' },
  ...overrides,
})

test('upcoming bookings for the verified email, with reschedule and cancel links', async () => {
  const http = fakeHttp([[path('/v2/bookings'), () => ({ json: { status: 'success', data: [booking()] } })]])
  const result = await calcom.lookup(config(), input, http)
  assert.ok(result.status === 'ok')
  assert.deepEqual(result.data, {
    bookings: [
      {
        title: 'Consultation with Dr. Lee',
        start: '2026-11-02T15:00:00.000Z',
        end: '2026-11-02T15:30:00.000Z',
        timeZone: 'Europe/London',
        status: 'accepted',
        rescheduleLink: 'https://cal.com/reschedule/abc123XYZ',
        cancelLink: 'https://cal.com/booking/abc123XYZ?cancel=true',
      },
    ],
  })
  assertAbsent(result, ['Baker Street', 'medical', 'other@example.com', KEY])
  const [call] = http.calls
  assert.equal(call!.parsed.origin, 'https://api.cal.com')
  assert.equal(call!.parsed.searchParams.get('attendeeEmail'), 'sam@example.com')
  assert.equal(call!.parsed.searchParams.get('status'), 'upcoming')
  assert.equal(call!.headers!.Authorization, `Bearer ${KEY}`)
  assert.equal(call!.headers!['cal-api-version'], '2024-08-13')
  assert.equal(call!.method ?? 'GET', 'GET')
  assert.equal(call!.allowPrivate, false)
})

test('bookings the visitor isn’t an attendee of are dropped', async () => {
  const http = fakeHttp([[path('/v2/bookings'), () => ({ json: { data: [booking({ attendees: [{ email: 'someone@else.com' }] })] } })]])
  assert.deepEqual(await calcom.lookup(config(), input, http), { status: 'not_found', summary: 'no upcoming bookings for this email' })
})

test('cancelled bookings and odd ids get no links; links can be turned off', async () => {
  const http = fakeHttp([
    [path('/v2/bookings'), () => ({ json: { data: [booking({ status: 'CANCELLED' }), booking({ uid: '../../admin' })] } })],
  ])
  const result = await calcom.lookup(config(), input, http)
  assert.ok(result.status === 'ok')
  for (const b of (result.data as any).bookings) {
    assert.equal(b.rescheduleLink, null)
    assert.equal(b.cancelLink, null)
  }
  const off = await calcom.lookup(config({}, { include_links: false }), input, fakeHttp([[path('/v2/bookings'), () => ({ json: { data: [booking()] } })]]))
  assert.ok(off.status === 'ok')
  assert.equal((off.data as any).bookings[0].rescheduleLink, null)
})

test('a self-hosted Cal.com uses its own addresses; only it may be on a private network', async () => {
  const http = fakeHttp([[path('/v2/bookings'), () => ({ json: { data: [booking()] } })]])
  const selfHosted = config({ api_url: 'https://cal-api.internal.example', app_url: 'https://book.example.com/' }, {}, true)
  const result = await calcom.lookup(selfHosted, input, http)
  assert.ok(result.status === 'ok')
  assert.equal((result.data as any).bookings[0].rescheduleLink, 'https://book.example.com/reschedule/abc123XYZ')
  assert.equal(http.calls[0]!.parsed.origin, 'https://cal-api.internal.example')
  assert.equal(http.calls[0]!.allowPrivate, true)
  // The cloud API never gets the private-network exception.
  const cloud = fakeHttp([[path('/v2/bookings'), () => ({ json: { data: [] } })]])
  await calcom.lookup(config({}, {}, true), input, cloud)
  assert.equal(cloud.calls[0]!.allowPrivate, false)
})

test('an http API address is refused', async () => {
  const http = fakeHttp([])
  await assert.rejects(calcom.lookup(config({ api_url: 'http://cal.example.com' }), input, http), failsWith('error', /https/))
  assert.equal(http.calls.length, 0)
  assert.ok(calcom.fields.find((f) => f.name === 'api_url')!.validate!('http://x.example'))
})

test('the connection test says who the key belongs to', async () => {
  const http = fakeHttp([[path('/v2/me'), () => ({ json: { status: 'success', data: { username: 'dr-lee', email: 'lee@clinic.example' } } })]])
  assert.deepEqual(await calcom.test(config(), http), { ok: true, detail: 'Connected as dr-lee.' })
  await assert.rejects(calcom.test(config(), fakeHttp([[path('/v2/me'), () => ({ status: 401, json: {} })]])), failsWith('rejected'))
})

test('booking questions match the topic', () => {
  const topics = calcom.topics(config())!
  for (const q of ['When is my appointment?', 'I need to reschedule', 'can I move my booking']) assert.ok(topics.test(q), q)
  assert.ok(!topics.test('What does the clinic charge?'))
})
