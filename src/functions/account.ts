import { createServerFn } from '@tanstack/react-start'
import { asObject } from './validate.ts'
import { requireUser } from '../server/auth.server.ts'
import { getAccount, setNotificationPrefs } from '../server/account.server.ts'
import { allowAll } from '../server/rate-limit.server.ts'
import { MAX_AVATAR_BYTES, removeAvatar, saveAvatar } from '../server/avatars.server.ts'

// Everyone's own account settings (not the app's settings, which are admin-only).
export const getMyAccount = createServerFn({ method: 'GET' }).handler(() => getAccount(requireUser().id))

export const setMyNotifications = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const o = asObject(input)
    if (typeof o.handoff !== 'boolean' || typeof o.newConversations !== 'boolean') throw new Error('Invalid notification settings.')
    return { handoff: o.handoff, newConversations: o.newConversations }
  })
  .handler(({ data }) => {
    const me = requireUser()
    setNotificationPrefs(me.id, data)
    return getAccount(me.id)
  })

// Your profile picture, shown beside your replies in the chat. The browser
// has already cropped and shrunk it (prepareAvatar); the server checks the bytes.
export const uploadMyAvatar = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    if (!(input instanceof FormData)) throw new Error('Expected a picture.')
    const file = input.get('file')
    if (!(file instanceof File) || file.size === 0) throw new Error('Choose a picture.')
    if (file.size > MAX_AVATAR_BYTES) throw new Error('That picture is too large. Choose a smaller one.')
    return { file }
  })
  .handler(async ({ data }) => {
    const me = requireUser()
    if (!allowAll([{ key: `avatar:${me.id}`, max: 20, windowMs: 10 * 60_000 }])) throw new Error('That’s a lot of uploads. Try again in a few minutes.')
    saveAvatar(me.id, new Uint8Array(await data.file.arrayBuffer()))
    return getAccount(me.id)
  })

export const removeMyAvatar = createServerFn({ method: 'POST' }).handler(() => {
  const me = requireUser()
  removeAvatar(me.id)
  return getAccount(me.id)
})
