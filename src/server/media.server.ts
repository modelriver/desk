import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { env } from './env.server.ts'
import { sha256Hex, signAwsRequest } from './aws-sigv4.server.ts'
import type { MediaStorage, S3Storage } from './media-config.server.ts'
import { detectImageType, formatBytes, IMAGE_TYPES, MAX_IMAGE_BYTES, MEDIA_NAME, MEDIA_PATH, mediaName, type ImageExt } from '../lib/media-core.ts'
import { errorMessage } from '../lib/errors.ts'

// Images uploaded into articles (see lib/media-core.ts for the rules and
// media-config.server.ts for where they go). Names come from the contents,
// so a file is never overwritten with something else and caches keep it forever.

const CACHE_FOREVER = 'public, max-age=31536000, immutable'
const S3_TIMEOUT_MS = 20_000

export interface SavedImage {
  url: string
  name: string
  bytes: number
}

// Checks the bytes are an image we accept, stores them, and returns the
// address to put in the article.
export async function saveImage(bytes: Uint8Array, storage: MediaStorage = env.media): Promise<SavedImage> {
  if (bytes.length === 0) throw new Error('That image is empty.')
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error(`Images must be ${formatBytes(MAX_IMAGE_BYTES)} or smaller.`)
  const ext = detectImageType(bytes)
  if (!ext) throw new Error('Use a PNG, JPEG, WebP, GIF or AVIF image.')

  const hash = sha256Hex(bytes)
  const name = mediaName(hash, ext)
  if (storage.s3) {
    await putObject(storage.s3, name, bytes, ext, hash)
    return { url: `${storage.s3.publicUrl}/${storage.s3.prefix}${name}`, name, bytes: bytes.length }
  }
  writeLocal(storage.dir, name, bytes)
  return { url: MEDIA_PATH + name, name, bytes: bytes.length }
}

function writeLocal(dir: string, name: string, bytes: Uint8Array) {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, name)
  if (fs.existsSync(file)) return
  // Written aside and renamed, so a half-written file is never served.
  const temp = path.join(dir, `.${name}.${randomBytes(6).toString('hex')}.tmp`)
  fs.writeFileSync(temp, bytes, { flag: 'wx' })
  fs.renameSync(temp, file)
}

// PUT to an S3-compatible bucket, path-style (endpoint/bucket/key), which
// Amazon S3, Cloudflare R2 and MinIO all accept.
async function putObject(s3: S3Storage, name: string, bytes: Uint8Array, ext: ImageExt, hash: string) {
  const url = `${s3.endpoint}/${s3.bucket}/${s3.prefix}${name}`
  const headers = signAwsRequest({
    method: 'PUT',
    url,
    headers: { 'content-type': IMAGE_TYPES[ext], 'cache-control': CACHE_FOREVER, 'x-amz-content-sha256': hash },
    body: bytes,
    region: s3.region,
    service: 's3',
    credentials: { accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey },
  })
  let res: Response
  try {
    res = await fetch(url, { method: 'PUT', headers, body: bytes as Uint8Array<ArrayBuffer>, signal: AbortSignal.timeout(S3_TIMEOUT_MS) })
  } catch (err) {
    throw new Error(`Couldn’t reach the image storage: ${errorMessage(err)}`)
  }
  if (!res.ok) throw new Error(`The image storage refused the upload (${res.status}${s3Error(await res.text().catch(() => ''))}).`)
}

// "AccessDenied: Access Denied" from an S3 error document.
function s3Error(xml: string): string {
  const code = /<Code>([^<]{1,100})<\/Code>/.exec(xml)?.[1]
  const message = /<Message>([^<]{1,300})<\/Message>/.exec(xml)?.[1]
  return code ? `, ${code}${message ? `: ${message}` : ''}` : ''
}

// GET /media/<name>: an image stored on this server. Only names this app
// makes are looked up, so nothing else in the folder (or outside it) is reachable.
export function mediaResponse(name: string, { head = false, storage = env.media } = {}): Response {
  const notFound = () => new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
  if (!MEDIA_NAME.test(name)) return notFound()
  const file = path.join(storage.dir, name)
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(file)
  } catch {
    return notFound()
  }
  if (!stat.isFile()) return notFound()
  const ext = name.slice(name.lastIndexOf('.') + 1) as ImageExt
  return new Response(head ? null : fs.readFileSync(file), {
    headers: {
      'Content-Type': IMAGE_TYPES[ext],
      'Content-Length': String(stat.size),
      'Cache-Control': CACHE_FOREVER,
      // server.mjs adds this (and the CSP) in production; this covers development.
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

// For Settings: where images go, and how many are stored here.
export function mediaStatus(storage: MediaStorage = env.media) {
  const local = localImages(storage.dir)
  if (!storage.s3) return { kind: 'local' as const, dir: storage.dir, ...local }
  const { endpoint, bucket, prefix, region, publicUrl } = storage.s3
  // Images saved here before the bucket was set up are still served from this server.
  return { kind: 's3' as const, endpoint, bucket, prefix, region, publicUrl, dir: storage.dir, ...local }
}

function localImages(dir: string) {
  let count = 0
  let bytes = 0
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !MEDIA_NAME.test(entry.name)) continue
      count++
      bytes += fs.statSync(path.join(dir, entry.name)).size
    }
  } catch {
    // No folder yet: nothing uploaded.
  }
  return { count, bytes }
}

// A 1×1 PNG. Being named after its contents, every test stores the same file.
const TEST_IMAGE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64')

// Settings' "Test upload": stores a tiny image, then (for a bucket) checks it
// can be loaded from MEDIA_PUBLIC_URL, which is what visitors' browsers do.
export async function testMediaStorage(storage: MediaStorage = env.media): Promise<SavedImage & { reachable: boolean | null; status: number | null }> {
  const saved = await saveImage(TEST_IMAGE, storage)
  if (!storage.s3) return { ...saved, reachable: null, status: null }
  try {
    const res = await fetch(saved.url, { method: 'HEAD', signal: AbortSignal.timeout(10_000) })
    return { ...saved, reachable: res.ok, status: res.status }
  } catch {
    return { ...saved, reachable: false, status: null }
  }
}
