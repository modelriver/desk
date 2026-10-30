// Images uploaded into articles. Shared by the browser (to check and shrink a
// file before sending it) and the server (which trusts only the bytes).

// Under the 2 MB request limit in server.mjs, Caddy and nginx, with room for
// the form around it. The browser shrinks photos to fit; GIFs can't be.
export const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024
// The longest side a photo is shrunk to before it's sent.
export const MAX_IMAGE_SIDE = 2400

export type ImageExt = 'png' | 'jpg' | 'gif' | 'webp' | 'avif'

export const IMAGE_TYPES: Record<ImageExt, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
}

// Every stored image is named after its contents: 32 hex characters of its
// SHA-256 and its type. The same image uploaded twice is one file, and a name
// can never be reused for different contents, so it can be cached forever.
export const MEDIA_NAME = /^[a-f0-9]{32}\.(?:png|jpg|gif|webp|avif)$/
export const MEDIA_PATH = '/media/'

export function mediaName(sha256Hex: string, ext: ImageExt): string {
  return `${sha256Hex.slice(0, 32)}.${ext}`
}

// What an image really is, from its first bytes. SVG is never accepted: it
// can carry scripts.
export function detectImageType(bytes: Uint8Array): ImageExt | null {
  const starts = (sig: number[], at = 0) => bytes.length >= at + sig.length && sig.every((b, i) => bytes[at + i] === b)
  const ascii = (at: number, len: number) => String.fromCharCode(...bytes.subarray(at, at + len))
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png'
  if (starts([0xff, 0xd8, 0xff])) return 'jpg'
  if (starts([0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return 'gif'
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'webp'
  if (bytes.length >= 12 && ascii(4, 4) === 'ftyp' && ['avif', 'avis'].includes(ascii(8, 4))) return 'avif'
  return null
}

// Image sources an article may use: a web address, or an image uploaded here.
export function isImageSrc(src: string): boolean {
  const value = src.trim()
  if (/^https:\/\/\S+$/i.test(value)) return true
  return value.startsWith(MEDIA_PATH) && MEDIA_NAME.test(value.slice(MEDIA_PATH.length))
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MB`
}
