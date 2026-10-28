import type { DatabaseSync } from 'node:sqlite'
import { buildAccountMessage } from '../lib/prompt-core.ts'
import { identityMethods } from './identity.server.ts'
import { connectorName, processEnv, relevantConnectors, runLookups, type IntegrationsEnv } from './integrations.server.ts'
import type { RequestFn } from './safe-http.server.ts'

// The account part of a chat turn: whether the question needs a connector,
// and either what the connectors found for the verified visitor, or a note
// that they need to verify their email first.

export interface AccountContext {
  // Added to the turn's system message; null when no connector applies.
  message: string | null
  // Ask the visitor to verify their email (the widget shows a card).
  // expired: they had, but it lapsed, so they're asked again.
  verify: { services: string[]; expired: boolean } | null
  // Services looked up this turn, for the widget.
  checked: string[]
}

export const NO_ACCOUNT: AccountContext = { message: null, verify: null, checked: [] }

export async function accountContext(
  db: DatabaseSync,
  input: {
    conversation: { id: string; mode: 'ai' | 'human'; verified_email: string | null }
    text: string
    ip: string
    // The visitor asked for a person: the AI only acknowledges, so no lookups.
    waiting: boolean
    // The visitor's earlier verification just lapsed.
    verificationExpired?: boolean
    canVerify?: boolean
  },
  deps: { request?: RequestFn } = {},
  e: IntegrationsEnv = processEnv(),
): Promise<AccountContext> {
  if (input.waiting || input.conversation.mode !== 'ai') return NO_ACCOUNT
  const connectors = relevantConnectors(db, { text: input.text, conversationId: input.conversation.id }, e)
  if (!connectors.length) return NO_ACCOUNT
  const services = connectors.map((c) => connectorName(db, c, e))

  const email = input.conversation.verified_email
  if (!email) {
    // An identity token can only come from the site embedding the widget, so
    // inside the chat the visitor can only verify by email code.
    const canVerify = input.canVerify ?? identityMethods().emailCode
    const expired = input.verificationExpired === true
    return {
      message: buildAccountMessage({ verified: false, services, canVerify, expired }),
      verify: canVerify ? { services, expired } : null,
      checked: [],
    }
  }
  const lookups = await runLookups(db, { conversationId: input.conversation.id, email, question: input.text, ip: input.ip, connectors }, deps, e)
  return {
    message: buildAccountMessage({ verified: true, email, lookups }),
    verify: null,
    checked: lookups.filter((l) => l.status === 'ok' || l.status === 'not_found').map((l) => l.label),
  }
}
