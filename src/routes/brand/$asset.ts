import { createFileRoute } from '@tanstack/react-router'
import { brandAssetResponse } from '../../server/branding.server.ts'

// /brand/logo, /brand/logo-dark and /brand/favicon: the images uploaded in Settings (see branding.server.ts).
export const Route = createFileRoute('/brand/$asset')({
  server: {
    handlers: {
      GET: ({ params, request }) => brandAssetResponse(params.asset, new URL(request.url).searchParams.get('v')),
      HEAD: ({ params, request }) => brandAssetResponse(params.asset, new URL(request.url).searchParams.get('v'), { head: true }),
    },
  },
})
