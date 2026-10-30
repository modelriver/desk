import { createFileRoute } from '@tanstack/react-router'
import { avatarResponse } from '../../server/avatars.server.ts'

// Team members' profile pictures, by hash (see avatars.server.ts).
export const Route = createFileRoute('/avatars/$hash')({
  server: {
    handlers: {
      GET: ({ params }) => avatarResponse(params.hash),
      HEAD: ({ params }) => avatarResponse(params.hash, { head: true }),
    },
  },
})
