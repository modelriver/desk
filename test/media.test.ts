import { test, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { detectImageType, isImageSrc, MAX_IMAGE_BYTES, MEDIA_NAME, mediaName } from '../src/lib/media-core.ts'
import { readMediaStorage, type MediaStorage } from '../src/server/media-config.server.ts'
import { pastedFromWeb, webImageSrc } from '../src/lib/image-prepare.ts'
import { signAwsRequest } from '../src/server/aws-sigv4.server.ts'
import { mediaResponse, mediaStatus, saveImage, testMediaStorage } from '../src/server/media.server.ts'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-media-'))
after(() => fs.rmSync(dir, { recursive: true, force: true }))

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64')
const bytes = (...values: number[]) => Uint8Array.from(values)
const ascii = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0))
const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')

test('image types come from the bytes, never the name', () => {
  assert.equal(detectImageType(PNG), 'png')
  assert.equal(detectImageType(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0)), 'jpg')
  assert.equal(detectImageType(ascii('GIF89a....')), 'gif')
  assert.equal(detectImageType(ascii('GIF87a....')), 'gif')
  assert.equal(detectImageType(ascii('RIFF\0\0\0\0WEBPVP8 ')), 'webp')
  assert.equal(detectImageType(ascii('\0\0\0\x1cftypavif')), 'avif')
  assert.equal(detectImageType(ascii('\0\0\0\x1cftypavis')), 'avif')
  for (const other of [ascii('<svg xmlns="http://www.w3.org/2000/svg"/>'), ascii('<html>'), ascii('RIFF\0\0\0\0WAVE'), ascii('\0\0\0\x1cftypmp42'), bytes(0x89, 0x50), bytes()]) {
    assert.equal(detectImageType(other), null)
  }
})

test('stored names are 32 hex characters and the type', () => {
  const name = mediaName(sha(PNG), 'png')
  assert.match(name, MEDIA_NAME)
  assert.equal(name, `${sha(PNG).slice(0, 32)}.png`)
  for (const bad of ['../x.png', 'abc.png', `${'a'.repeat(32)}.svg`, `${'A'.repeat(32)}.png`, `${'a'.repeat(32)}.png/..`]) assert.doesNotMatch(bad, MEDIA_NAME, bad)
})

test('articles may use web images and images uploaded here', () => {
  assert.ok(isImageSrc('https://cdn.acme.com/a.png'))
  assert.ok(isImageSrc(`/media/${'a'.repeat(32)}.webp`))
  for (const bad of ['http://acme.com/a.png', 'data:image/png;base64,AAAA', 'javascript:alert(1)', '/media/../support.db', '/media/a.png', `//media/${'a'.repeat(32)}.png`, '/other/a.png']) {
    assert.equal(isImageSrc(bad), false, bad)
  }
})

test('storage: a folder by default, MEDIA_DIR to move it', () => {
  assert.deepEqual(readMediaStorage({}, '/srv/data'), { dir: '/srv/data/media', s3: null })
  assert.equal(readMediaStorage({ MEDIA_DIR: '/srv/images' }, '/srv/data').dir, '/srv/images')
})

test('storage: a bucket needs all its settings', () => {
  assert.throws(() => readMediaStorage({ MEDIA_S3_BUCKET: 'help-images' }, '/d'), /MEDIA_S3_ACCESS_KEY_ID, MEDIA_S3_SECRET_ACCESS_KEY, MEDIA_PUBLIC_URL/)
  const base = { MEDIA_S3_BUCKET: 'help-images', MEDIA_S3_ACCESS_KEY_ID: 'AK', MEDIA_S3_SECRET_ACCESS_KEY: 'SK', MEDIA_PUBLIC_URL: 'https://cdn.acme.com/' }
  assert.throws(() => readMediaStorage({ ...base, MEDIA_PUBLIC_URL: 'http://cdn.acme.com' }, '/d'), /https/)
  assert.throws(() => readMediaStorage({ ...base, MEDIA_S3_BUCKET: 'Help_Images' }, '/d'), /bucket name/)
  assert.throws(() => readMediaStorage({ ...base, MEDIA_S3_PREFIX: 'a/../b c' }, '/d'), /MEDIA_S3_PREFIX/)
  assert.throws(() => readMediaStorage({ ...base, MEDIA_S3_ENDPOINT: 'ftp://x' }, '/d'), /MEDIA_S3_ENDPOINT/)

  // Amazon S3 when no endpoint is given.
  const aws = readMediaStorage(base, '/d').s3!
  assert.equal(aws.endpoint, 'https://s3.us-east-1.amazonaws.com')
  assert.equal(aws.region, 'us-east-1')
  assert.equal(aws.publicUrl, 'https://cdn.acme.com')
  assert.equal(aws.prefix, '')

  // Cloudflare R2 signs with the region "auto".
  const r2 = readMediaStorage({ ...base, MEDIA_S3_ENDPOINT: 'https://abc123.r2.cloudflarestorage.com/', MEDIA_S3_PREFIX: '/assets/desk/' }, '/d').s3!
  assert.equal(r2.endpoint, 'https://abc123.r2.cloudflarestorage.com')
  assert.equal(r2.region, 'auto')
  assert.equal(r2.prefix, 'assets/desk/')
})

test('signing bytes and the same text gives the same signature', () => {
  const common = {
    method: 'PUT',
    url: 'https://s3.us-east-1.amazonaws.com/b/k.png',
    headers: { 'content-type': 'image/png' },
    region: 'us-east-1',
    service: 's3',
    credentials: { accessKeyId: 'AK', secretAccessKey: 'SK' },
    now: new Date('2026-10-29T10:00:00Z'),
  }
  assert.equal(signAwsRequest({ ...common, body: 'abc' }).Authorization, signAwsRequest({ ...common, body: Buffer.from('abc') }).Authorization)
  assert.notEqual(signAwsRequest({ ...common, body: 'abc' }).Authorization, signAwsRequest({ ...common, body: Buffer.from('abd') }).Authorization)
})

const local: MediaStorage = { dir: path.join(dir, 'media'), s3: null }

test('local: saved under its content hash, once, and served with long caching', async () => {
  const first = await saveImage(PNG, local)
  assert.equal(first.url, `/media/${sha(PNG).slice(0, 32)}.png`)
  assert.equal(first.bytes, PNG.length)
  assert.deepEqual(fs.readFileSync(path.join(local.dir, first.name)), PNG)

  const again = await saveImage(PNG, local)
  assert.equal(again.url, first.url)
  // No temporary files left behind.
  assert.deepEqual(fs.readdirSync(local.dir), [first.name])
  assert.deepEqual(mediaStatus(local), { kind: 'local', dir: local.dir, count: 1, bytes: PNG.length })

  const res = mediaResponse(first.name, { storage: local })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'image/png')
  assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable')
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG)

  const head = mediaResponse(first.name, { head: true, storage: local })
  assert.equal(head.status, 200)
  assert.equal(head.headers.get('content-length'), String(PNG.length))
  assert.equal(await head.text(), '')
})

test('local: anything that isn’t an image this app named is not found', () => {
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'secret')
  fs.writeFileSync(path.join(local.dir, 'notes.png'), 'x')
  for (const name of ['../secret.txt', 'notes.png', '', `${'b'.repeat(32)}.png`, `..%2F${'a'.repeat(32)}.png`]) {
    assert.equal(mediaResponse(name, { storage: local }).status, 404, name)
  }
  // A link planted in the folder isn't followed.
  const link = `${'c'.repeat(32)}.png`
  fs.symlinkSync(path.join(dir, 'secret.txt'), path.join(local.dir, link))
  assert.equal(mediaResponse(link, { storage: local }).status, 404)
})

test('only real images, up to the size limit, are saved', async () => {
  await assert.rejects(saveImage(ascii('<svg onload="alert(1)"/>'), local), /PNG, JPEG, WebP, GIF or AVIF/)
  await assert.rejects(saveImage(new Uint8Array(), local), /empty/)
  const huge = new Uint8Array(MAX_IMAGE_BYTES + 1)
  huge.set(PNG)
  await assert.rejects(saveImage(huge, local), /1\.5 MB or smaller/)
})

const bucket: MediaStorage = {
  dir: path.join(dir, 'unused'),
  s3: {
    endpoint: 'https://abc123.r2.cloudflarestorage.com',
    bucket: 'help-images',
    region: 'auto',
    accessKeyId: 'AKTEST',
    secretAccessKey: 'SKTEST',
    prefix: 'desk/',
    publicUrl: 'https://cdn.acme.com',
  },
}

function stubFetch(answer: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init })
    return answer(String(url), init)
  }) as typeof fetch
  return calls
}

test('bucket: a signed PUT, path-style, then the public address', async () => {
  const calls = stubFetch(() => new Response(null, { status: 200 }))
  const saved = await saveImage(PNG, bucket)
  const name = `${sha(PNG).slice(0, 32)}.png`
  assert.equal(saved.url, `https://cdn.acme.com/desk/${name}`)

  assert.equal(calls.length, 1)
  const { url, init } = calls[0]!
  assert.equal(url, `https://abc123.r2.cloudflarestorage.com/help-images/desk/${name}`)
  assert.equal(init.method, 'PUT')
  const headers = init.headers as Record<string, string>
  assert.equal(headers['content-type'], 'image/png')
  assert.equal(headers['cache-control'], 'public, max-age=31536000, immutable')
  assert.equal(headers['x-amz-content-sha256'], sha(PNG))
  assert.match(headers.Authorization!, /^AWS4-HMAC-SHA256 Credential=AKTEST\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=cache-control;content-type;host;x-amz-content-sha256;x-amz-date, Signature=[a-f0-9]{64}$/)
  assert.deepEqual(Buffer.from(init.body as Uint8Array), PNG)
  // Nothing is written locally.
  assert.equal(fs.existsSync(bucket.dir), false)
})

test('bucket: a refusal says why', async () => {
  stubFetch(() => new Response('<?xml version="1.0"?><Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>', { status: 403 }))
  await assert.rejects(saveImage(PNG, bucket), /refused the upload \(403, AccessDenied: Access Denied\)/)
  stubFetch(() => {
    throw new TypeError('fetch failed')
  })
  await assert.rejects(saveImage(PNG, bucket), /Couldn’t reach the image storage: fetch failed/)
})

test('bucket: the test upload checks visitors can load the image', async () => {
  let calls = stubFetch(() => new Response(null, { status: 200 }))
  const ok = await testMediaStorage(bucket)
  assert.equal(ok.reachable, true)
  assert.deepEqual(
    calls.map((c) => c.init.method),
    ['PUT', 'HEAD'],
  )
  assert.equal(calls[1]!.url, ok.url)

  calls = stubFetch((_url, init) => new Response(null, { status: init.method === 'HEAD' ? 403 : 200 }))
  const blocked = await testMediaStorage(bucket)
  assert.equal(blocked.reachable, false)
  assert.equal(blocked.status, 403)
})

test('local: the test upload saves the tiny image', async () => {
  const res = await testMediaStorage({ dir: path.join(dir, 'test-media'), s3: null })
  assert.equal(res.reachable, null)
  assert.ok(fs.existsSync(path.join(dir, 'test-media', res.name)))
})

test('an image copied from a web page keeps its address', () => {
  const clip = (html: string) => ({ getData: (type: string) => (type === 'text/html' ? html : '') }) as unknown as DataTransfer
  const page = clip('<meta charset="utf-8"><img src="https://cdn.acme.com/a.png?w=1&amp;h=2" alt="A">')
  assert.equal(pastedFromWeb(page), true)
  assert.equal(webImageSrc(page), 'https://cdn.acme.com/a.png?w=1&h=2')
  assert.equal(webImageSrc(clip("<img src='https://x.com/a_(1).png'>")), 'https://x.com/a_%281%29.png')
  // Plain http can't be used in an article; a screenshot has no page at all.
  assert.equal(pastedFromWeb(clip('<img src="http://x.com/a.png">')), true)
  assert.equal(webImageSrc(clip('<img src="http://x.com/a.png">')), null)
  assert.equal(pastedFromWeb(clip('')), false)
  assert.equal(pastedFromWeb(null), false)
})
