import path from 'node:path'

// Where images uploaded into articles are kept, from the environment (read by
// env.server.ts, so a half-finished setup stops the server at start).
//   - Unset: files in MEDIA_DIR (default DATA_DIR/media), served by Desk at /media/….
//   - MEDIA_S3_BUCKET and friends: any S3-compatible store (Amazon S3,
//     Cloudflare R2, MinIO, …), with images served from MEDIA_PUBLIC_URL.

export interface S3Storage {
  endpoint: string
  bucket: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  // Folder inside the bucket, '' or ending in '/'.
  prefix: string
  // Where the bucket's objects are public, e.g. https://cdn.acme.com (no trailing slash).
  publicUrl: string
}

export interface MediaStorage {
  dir: string
  s3: S3Storage | null
}

const S3_SETTINGS = ['MEDIA_S3_ENDPOINT', 'MEDIA_S3_BUCKET', 'MEDIA_S3_REGION', 'MEDIA_S3_ACCESS_KEY_ID', 'MEDIA_S3_SECRET_ACCESS_KEY', 'MEDIA_S3_PREFIX', 'MEDIA_PUBLIC_URL']
const S3_REQUIRED = ['MEDIA_S3_BUCKET', 'MEDIA_S3_ACCESS_KEY_ID', 'MEDIA_S3_SECRET_ACCESS_KEY', 'MEDIA_PUBLIC_URL']

export function readMediaStorage(vars: Record<string, string | undefined>, dataDir: string): MediaStorage {
  const get = (name: string) => (vars[name] ?? '').trim()
  const dir = path.resolve(get('MEDIA_DIR') || path.join(dataDir, 'media'))
  if (!S3_SETTINGS.some((name) => get(name))) return { dir, s3: null }

  const missing = S3_REQUIRED.filter((name) => !get(name))
  if (missing.length) throw new Error(`Image storage: set ${missing.join(', ')} too, or none of the MEDIA_S3_ settings.`)

  const bucket = get('MEDIA_S3_BUCKET')
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error('MEDIA_S3_BUCKET must be a bucket name (lowercase letters, numbers, dots and dashes).')

  const prefix = get('MEDIA_S3_PREFIX').replace(/^\/+|\/+$/g, '')
  if (prefix && !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(prefix)) {
    throw new Error('MEDIA_S3_PREFIX may use letters, numbers, dots, dashes, underscores and slashes.')
  }

  const endpointRaw = get('MEDIA_S3_ENDPOINT')
  const region = get('MEDIA_S3_REGION') || (/\.r2\.cloudflarestorage\.com$/i.test(hostOf(endpointRaw)) ? 'auto' : 'us-east-1')
  const endpoint = trimSlashes(endpointRaw || `https://s3.${region}.amazonaws.com`)
  if (!/^https?:$/.test(protocolOf(endpoint))) throw new Error('MEDIA_S3_ENDPOINT must be an http(s):// address.')

  // Pages only load images from this site or https:// addresses (see the CSP in server.mjs).
  const publicUrl = trimSlashes(get('MEDIA_PUBLIC_URL'))
  if (protocolOf(publicUrl) !== 'https:') throw new Error('MEDIA_PUBLIC_URL must be an https:// address.')

  return {
    dir,
    s3: {
      endpoint,
      bucket,
      region,
      accessKeyId: get('MEDIA_S3_ACCESS_KEY_ID'),
      secretAccessKey: get('MEDIA_S3_SECRET_ACCESS_KEY'),
      prefix: prefix ? `${prefix}/` : '',
      publicUrl,
    },
  }
}

const trimSlashes = (url: string) => url.replace(/\/+$/, '')

function protocolOf(url: string): string {
  try {
    return new URL(url).protocol
  } catch {
    return ''
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}
