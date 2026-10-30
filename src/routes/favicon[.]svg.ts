import { createFileRoute } from '@tanstack/react-router'
import { faviconResponse } from '../server/site-config.server.ts'

// /favicon.svg: the Desk bot in the theme's colours (a custom logo replaces it; see __root.tsx).
export const Route = createFileRoute('/favicon.svg')({
  server: { handlers: { GET: () => faviconResponse() } },
})
