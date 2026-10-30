import { formatBytes, MAX_IMAGE_BYTES, MAX_IMAGE_SIDE } from './media-core.ts'

// In the browser, before an image is uploaded into an article: big photos are
// shrunk to MAX_IMAGE_SIDE and re-encoded, which also drops their metadata
// (camera, location). GIFs are sent as they are, so they keep moving.

export const ACCEPTED_IMAGES = 'image/png,image/jpeg,image/gif,image/webp,image/avif'

// Image files among what was pasted or dropped.
export function imageFiles(data: DataTransfer | null): File[] {
  return [...(data?.files ?? [])].filter((f) => f.type.startsWith('image/'))
}

// Copied from a web page: the clipboard has the page's <img> with its web
// address as well as the picture. Keep the address rather than uploading a copy.
export function pastedFromWeb(data: DataTransfer | null): boolean {
  return /<img\b[^>]*\bsrc\s*=\s*["']?https?:/i.test(data?.getData('text/html') ?? '')
}

// That web address, when it's one an article can use (https://).
export function webImageSrc(data: DataTransfer | null): string | null {
  const src = /<img\b[^>]*\bsrc\s*=\s*["']?(https:\/\/[^"'\s>]+)/i.exec(data?.getData('text/html') ?? '')?.[1]
  // Brackets would end the Markdown link early.
  return src ? src.replace(/&amp;/g, '&').replace(/\(/g, '%28').replace(/\)/g, '%29') : null
}

// Small screenshots stay PNG, crisp; anything bigger becomes WebP.
const KEEP_PNG_BYTES = 400 * 1024

export async function prepareImage(file: File): Promise<Blob> {
  if (file.type === 'image/svg+xml') throw new Error('SVG images can’t be uploaded. Use PNG, JPEG, WebP, GIF or AVIF.')
  if (file.type === 'image/gif') {
    if (file.size > MAX_IMAGE_BYTES) throw new Error(`GIFs must be ${formatBytes(MAX_IMAGE_BYTES)} or smaller (they can’t be shrunk without losing their motion).`)
    return file
  }

  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    throw new Error('This browser can’t read that image. Use PNG, JPEG, WebP, GIF or AVIF.')
  }
  try {
    let scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height))
    if (file.type === 'image/png') {
      const png = await encode(bitmap, scale, 'image/png')
      if (png.size <= KEEP_PNG_BYTES) return png
    }
    // Shrink further until it fits; photos rarely need a second try.
    for (let quality = 0.86; ; ) {
      const blob = await encode(bitmap, scale, 'image/webp', quality, file.type === 'image/png')
      if (blob.size <= MAX_IMAGE_BYTES) return blob
      if (scale * Math.max(bitmap.width, bitmap.height) < 600) break
      scale *= 0.8
      quality = Math.max(0.7, quality - 0.05)
    }
  } finally {
    bitmap.close()
  }
  throw new Error(`That image is too big to upload, even shrunk. Images must be ${formatBytes(MAX_IMAGE_BYTES)} or smaller.`)
}

async function encode(bitmap: ImageBitmap, scale: number, type: string, quality?: number, alpha = false): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('This browser can’t prepare images for upload.')
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  const blob = await toBlob(canvas, type, quality)
  if (blob.type === type) return blob
  // Safari can't write WebP and hands back a PNG: use JPEG for photos, PNG
  // where there may be transparency.
  return alpha ? toBlob(canvas, 'image/png') : toBlob(canvas, 'image/jpeg', quality)
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('This browser couldn’t prepare that image.'))), type, quality),
  )
}

// A profile picture: the middle square of the photo at 256 × 256 (shown at
// 26 px, sharp on a 2× screen and then some), as WebP. Re-encoding drops the
// photo's metadata too.
const AVATAR_SIDE = 256

export async function prepareAvatar(file: File): Promise<Blob> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    throw new Error('This browser can’t read that picture. Use PNG, JPEG or WebP.')
  }
  try {
    const side = Math.min(bitmap.width, bitmap.height)
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = AVATAR_SIDE
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('This browser can’t prepare pictures for upload.')
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, AVATAR_SIDE, AVATAR_SIDE)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.88))
    if (!blob) throw new Error('This browser can’t prepare pictures for upload.')
    return blob
  } finally {
    bitmap.close()
  }
}
