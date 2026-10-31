import { createFileRoute, redirect } from '@tanstack/react-router'

// Knowledge used to live at /dashboard/data: old bookmarks and links land on it.
export const Route = createFileRoute('/dashboard/data')({
  beforeLoad: () => {
    throw redirect({ to: '/dashboard/knowledge', replace: true })
  },
})
