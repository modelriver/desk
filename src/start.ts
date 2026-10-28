import { createCsrfMiddleware, createStart } from '@tanstack/react-start'

// Reject cross-site POSTs (server function calls) using Sec-Fetch-Site/Origin.
// Plain page loads (GET/HEAD) are left alone so links from other sites work.
const csrf = createCsrfMiddleware({
  filter: ({ request }) => request.method !== 'GET' && request.method !== 'HEAD',
})

export const startInstance = createStart(() => ({
  requestMiddleware: [csrf],
}))
