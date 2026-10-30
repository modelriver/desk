import { createFileRoute } from '@tanstack/react-router'
import { mediaResponse } from '../../server/media.server.ts'

// Images uploaded into articles, when they're kept on this server (see media.server.ts).
export const Route = createFileRoute('/media/$')({
  server: {
    handlers: {
      GET: ({ params }) => mediaResponse(params._splat ?? ''),
      HEAD: ({ params }) => mediaResponse(params._splat ?? '', { head: true }),
    },
  },
})
