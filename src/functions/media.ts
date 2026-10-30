import { createServerFn } from '@tanstack/react-start'
import { requireUser } from '../server/auth.server.ts'
import { allowAll } from '../server/rate-limit.server.ts'
import { saveImage, testMediaStorage } from '../server/media.server.ts'
import { formatBytes, MAX_IMAGE_BYTES } from '../lib/media-core.ts'

// An image pasted, dropped or picked in the article editor. The browser has
// already shrunk it (see lib/image-upload.ts); the server only trusts the bytes.
export const uploadImage = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    if (!(input instanceof FormData)) throw new Error('Expected an image.')
    const file = input.get('file')
    if (!(file instanceof File) || file.size === 0) throw new Error('Choose an image.')
    if (file.size > MAX_IMAGE_BYTES) throw new Error(`Images must be ${formatBytes(MAX_IMAGE_BYTES)} or smaller.`)
    return { file }
  })
  .handler(async ({ data }) => {
    const me = requireUser('admin')
    if (!allowAll([{ key: `image-upload:${me.id}`, max: 120, windowMs: 10 * 60_000 }])) {
      throw new Error('That’s a lot of images at once. Try again in a few minutes.')
    }
    return saveImage(new Uint8Array(await data.file.arrayBuffer()))
  })

// Settings: proves images can be stored (and, for a bucket, loaded by visitors).
export const testImageStorage = createServerFn({ method: 'POST' }).handler(async () => {
  const me = requireUser('admin')
  if (!allowAll([{ key: `image-test:${me.id}`, max: 5, windowMs: 10 * 60_000 }])) {
    throw new Error('That’s a few tests already. Try again in a few minutes.')
  }
  return testMediaStorage()
})
