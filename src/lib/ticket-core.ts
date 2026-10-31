import type { Chunk } from './content-core.ts'
import { articleUrl } from './help-path.ts'
import { escapeHtml } from './escape.ts'
import { URL_PATTERN } from './links.ts'

// Tickets: the pure parts (subjects, the reply email, the AI draft's prompt),
// shared by the server and tests.

export type TicketStatus = 'open' | 'pending' | 'solved'
export const TICKET_STATUSES: readonly TicketStatus[] = ['open', 'pending', 'solved']

export const TICKET_LIMITS = { subject: 120, body: 10_000, message: 2000 } as const

// Tickets one address can raise in a day, from the chat and the customer portal together.
export const TICKETS_PER_EMAIL_PER_DAY = 5

// A ticket's reference, shown as #K7F3Q9: six characters with no 0/O, 1/I/L
// or U, so it can be read out on a call. Random, so it says nothing about how
// many tickets there are (30^6, about 730 million, codes).
export const TICKET_REF_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'
export const TICKET_REF_LENGTH = 6

export function newTicketRef(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  // 240 is the largest multiple of 30 below 256: bytes above it are skipped, so every character is equally likely.
  let ref = ''
  while (ref.length < TICKET_REF_LENGTH) {
    for (const b of random(TICKET_REF_LENGTH * 2)) {
      if (b < 240 && ref.length < TICKET_REF_LENGTH) ref += TICKET_REF_ALPHABET[b % 30]
    }
  }
  return ref
}

// A reference as someone might type it: "#k7f3q9" or " K7F3Q9 ". Null if it can't be one.
export function normalizeTicketRef(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const ref = raw.trim().replace(/^#/, '').toUpperCase()
  return new RegExp(`^[${TICKET_REF_ALPHABET}]{${TICKET_REF_LENGTH}}$`).test(ref) ? ref : null
}

export const STATUS_LABEL: Record<TicketStatus, string> = {
  open: 'Open',
  pending: 'Waiting on customer',
  solved: 'Solved',
}

// A subject from the customer's own words: the first line, cut at a word.
export function subjectFrom(text: string, max = 80): string {
  const line = text.replace(/\s+/g, ' ').trim()
  if (line.length <= max) return line || 'Message from the chat'
  const cut = line.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s.,;:!?-]+$/, '')}…`
}

// Headers that keep a ticket's emails (the confirmation and every reply) in
// one thread in the customer's mail app: each points at the same made-up
// root message, which mail apps thread on even though it was never sent.
// Message-ID itself is left to the provider, which sets its own.
export function ticketThreadHeaders(ref: string, from: string): Record<string, string> {
  const domain = /@([A-Za-z0-9.-]+)>?\s*$/.exec(from)?.[1]?.toLowerCase() || 'desk.invalid'
  const root = `<ticket-${ref.toLowerCase()}@${domain}>`
  return { 'In-Reply-To': root, References: root }
}

// The email a customer gets for a reply: the reply, who sent it, and their
// original message underneath for context. Replies go to SUPPORT_REPLY_TO
// (or the sender address), so the subject carries the ticket's reference.
export function composeReplyEmail(input: {
  ticketRef: string
  subject: string
  body: string
  agentName: string
  brand: string
  original: string | null
  // The ticket's page, signed in for this customer: read everything and reply.
  link?: string | null
}) {
  const subject = `Re: ${input.subject} [#${input.ticketRef}]`
  const signOff = `${input.agentName}, ${input.brand}`
  const quote = input.original ? input.original.replace(/\s+$/, '') : null
  const text = [
    input.body.trim(),
    `— ${signOff}`,
    input.link ? `View the ticket and reply: ${input.link}` : null,
    quote ? `Your message:\n${quote.split('\n').map((l) => `> ${l}`).join('\n')}` : null,
  ]
    .filter(Boolean)
    .join('\n\n')
  const html = [
    '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:14px;line-height:1.55;color:#111">',
    `<div>${paragraphs(input.body)}</div>`,
    `<p style="margin:16px 0 0;color:#555">— ${escapeHtml(signOff)}</p>`,
    input.link
      ? `<p style="margin:20px 0 0"><a href="${escapeHtml(input.link)}" style="display:inline-block;padding:9px 16px;border-radius:8px;background:#111;color:#fff;text-decoration:none;font-weight:600">View ticket and reply</a></p>`
      : '',
    quote
      ? `<div style="margin:24px 0 0;padding:0 0 0 12px;border-left:3px solid #ddd;color:#666"><p style="margin:0 0 6px;font-size:12px">Your message</p>${paragraphs(quote)}</div>`
      : '',
    '</div>',
  ].join('')
  return { subject, text, html }
}

// The email a customer gets when they raise a ticket: its reference, a link
// to follow it in the customer portal, and their message for the record.
// The subject is the one replies use without "Re:", so they all thread together.
export function composeTicketConfirmation(input: { ticketRef: string; subject: string; brand: string; message: string; link: string | null }) {
  const subject = `${input.subject} [#${input.ticketRef}]`
  const intro = `Thanks for getting in touch. We’ve received your request, and our team will reply by email. Your ticket is #${input.ticketRef}.`
  const quote = input.message.replace(/\s+$/, '')
  const text = [
    intro,
    input.link ? `See it and add details: ${input.link}` : null,
    `Your message:\n${quote.split('\n').map((l) => `> ${l}`).join('\n')}`,
    `— ${input.brand}`,
  ]
    .filter(Boolean)
    .join('\n\n')
  const html = [
    '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:14px;line-height:1.55;color:#111">',
    `<p style="margin:0 0 12px">${escapeHtml(intro)}</p>`,
    input.link
      ? `<p style="margin:20px 0 0"><a href="${escapeHtml(input.link)}" style="display:inline-block;padding:9px 16px;border-radius:8px;background:#111;color:#fff;text-decoration:none;font-weight:600">View your ticket</a></p>`
      : '',
    `<div style="margin:24px 0 0;padding:0 0 0 12px;border-left:3px solid #ddd;color:#666"><p style="margin:0 0 6px;font-size:12px">Your message</p>${paragraphs(quote)}</div>`,
    `<p style="margin:16px 0 0;color:#555">— ${escapeHtml(input.brand)}</p>`,
    '</div>',
  ].join('')
  return { subject, text, html }
}

// Escaped text with its paragraphs and line breaks kept, and web links made clickable.
function paragraphs(text: string): string {
  return text
    .trim()
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 12px">${linkify(escapeHtml(p)).replace(/\n/g, '<br>')}</p>`)
    .join('')
}

function linkify(escaped: string): string {
  return escaped.replace(URL_PATTERN, (url) => `<a href="${url}" style="color:#111">${url}</a>`)
}

const MAX_CONTEXT_CHARS = 6000

export interface DraftTurn {
  // The customer's message, or a reply the team already sent.
  from: 'customer' | 'team'
  name: string
  body: string
}

// The prompt for an AI-drafted reply: the knowledge base excerpts and rules
// as a system message, the ticket's conversation (never its internal notes)
// as the user message. The team reviews the draft before anything is sent.
export function buildDraftMessages(input: { chunks: Chunk[]; turns: DraftTurn[]; customerName: string; siteUrl: string | null }) {
  const parts: string[] = []
  let used = 0
  for (const chunk of input.chunks) {
    const label =
      chunk.visibility === 'public'
        ? `${chunk.title} > ${chunk.heading}${input.siteUrl ? ` (${input.siteUrl}${articleUrl(chunk.path)})` : ''}`
        : `INTERNAL NOTE (use it, but never quote or mention it): ${chunk.heading}`
    const block = `### ${label}\n${chunk.text}`
    if (used + block.length > MAX_CONTEXT_CHARS) break
    parts.push(block)
    used += block.length
  }
  const rules = [
    'You are drafting an email reply that a support team member will review, edit and send to a customer.',
    'This is not the chat: the reply comes from the team itself, so never offer to connect them with the team, pass anything on or hand anything over, and never add markers in double square brackets.',
    'Answer the customer’s latest message using the knowledge base excerpts below. Internal notes may inform the answer, but never quote them, link them or say they exist.',
    input.siteUrl
      ? 'When an article helps, include its full link from the excerpt heading.'
      : 'When an article helps, mention its title.',
    'If the excerpts don’t answer it, don’t guess: write a short, polite reply asking for the details you need, and put [add details] where the team should fill something in. Never invent features, prices, policies or dates, and never promise refunds, credits or changes.',
    `Plain text, no Markdown headings or bold. Short paragraphs; a list with "-" is fine. Start with a greeting using the customer’s first name (${JSON.stringify(input.customerName)}). End without a sign-off or name: the team member’s name is added when it’s sent.`,
  ].join('\n')
  const body = parts.length ? parts.join('\n\n') : '(No matching articles were found.)'
  const thread = input.turns
    .map((t) => `${t.from === 'customer' ? `Customer (${t.name})` : `Our reply (${t.name})`}:\n${t.body.trim()}`)
    .join('\n\n')
  return [
    { role: 'system' as const, content: `${rules}\n\n## Knowledge base excerpts\n\n${body}` },
    { role: 'user' as const, content: `The ticket so far:\n\n${thread}\n\nDraft our next reply to the customer.` },
  ]
}

// A draft as the team should see it: the workflow's prompt is the chat
// assistant's, so the model may still add the chat's hidden markers
// ([[unsure]], [[handoff]], or a citation like [[billing-and-plans]]). They mean
// nothing in an email, so they're taken out, with any space left before them.
export function cleanDraft(text: string): string {
  return text
    .replace(/[ \t]*\[\[[a-z0-9][a-z0-9/_-]*\]\]/gi, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// The text of a model's answer, from the shapes ModelRiver returns.
export function textFromModel(data: unknown): string {
  if (typeof data === 'string') return data
  if (data && typeof data === 'object') {
    const d = data as Record<string, any>
    const text = d.content ?? d.text ?? d.message?.content ?? d.message ?? d.choices?.[0]?.message?.content
    if (typeof text === 'string') return text
  }
  return ''
}
