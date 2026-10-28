import { createServerFn } from '@tanstack/react-start'
import { asObject } from './validate.ts'
import { requireUser } from '../server/auth.server.ts'
import { getAccount, setNotificationPrefs } from '../server/account.server.ts'

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
