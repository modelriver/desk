import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { ChevronRightIcon, HeadsetIcon, UserIcon } from './icons.tsx'
import { Badge } from './ui.tsx'
import { RelativeTime } from './RelativeTime.tsx'
import { cn } from '../lib/cn.ts'
import type { listConversations } from '../functions/dashboard.ts'
import { initials as initialsOf } from '../lib/initials.ts'

export type ConversationSummary = Awaited<ReturnType<typeof listConversations>>['conversations'][number]

// The rows on Conversations and Archived. `action` renders the button at the
// end of a row (archive or restore); it sits outside the row's link.
export function ConversationList({
  conversations,
  currentUserId,
  action,
}: {
  conversations: ConversationSummary[]
  currentUserId: string
  action: (c: ConversationSummary) => ReactNode
}) {
  return (
    // No overflow-hidden: a row's confirmation popover may extend past the list.
    <ul className="divide-y divide-border rounded-xl border border-border bg-card">
      {conversations.map((c) => {
        const waiting = !!c.waitingSince && !c.endedAt && !c.archivedAt
        const handler = !c.endedAt && !c.archivedAt ? c.handledBy : null
        return (
          <li
            key={c.sessionId}
            className={cn(
              'relative flex items-center hover:bg-muted/60 first:rounded-t-xl last:rounded-b-xl',
              // Keeps an open popover above the rows after it.
              'has-[[role=alertdialog]]:z-10',
              // A stripe on the left edge marks someone waiting for a person.
              waiting &&
                'bg-primary/[0.04] before:absolute before:inset-y-0 before:left-0 before:w-0.75 before:bg-primary first:before:rounded-tl-xl last:before:rounded-bl-xl',
            )}
          >
            <Link
              to="/dashboard/c/$sessionId"
              params={{ sessionId: c.sessionId }}
              className="flex min-w-0 flex-1 items-center gap-3 py-3 pr-2 pl-4"
            >
              <span
                className={cn(
                  'grid size-8 shrink-0 place-items-center rounded-full',
                  waiting ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground',
                )}
              >
                {waiting ? <HeadsetIcon size={15} /> : <UserIcon size={15} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{c.visitorName ?? 'Visitor'}</span>
                <span className="block truncate text-sm text-muted-foreground">
                  {c.previewRole === 'assistant' && 'Reply: '}
                  {c.preview || 'No messages yet'}
                </span>
                <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                  {c.archivedAt ? (
                    <>
                      <span>
                        Archived <RelativeTime iso={c.archivedAt} />
                      </span>
                      {c.deleteAt && (
                        <>
                          <span aria-hidden="true">/</span>
                          <span>
                            Deleted <RelativeTime iso={c.deleteAt} future />
                          </span>
                        </>
                      )}
                    </>
                  ) : waiting ? (
                    <span className="font-medium text-primary">
                      {c.handoffReason === 'ai_error' ? 'Passed to the team' : 'Asked for a person'}{' '}
                      <RelativeTime iso={c.waitingSince!} />
                    </span>
                  ) : (
                    <RelativeTime iso={c.lastActivityAt} />
                  )}
                  <span aria-hidden="true">/</span>
                  <span>
                    {c.messageCount} {c.messageCount === 1 ? 'turn' : 'turns'}
                  </span>
                </span>
              </span>
              {c.archivedAt ? null : c.endedAt ? (
                <Badge variant="muted">Ended</Badge>
              ) : waiting ? (
                <Badge variant="priority" title={c.handoffReason === 'ai_error' ? 'The AI couldn’t answer, so the chat was passed to the team' : undefined}>
                  {c.handoffReason === 'ai_error' ? 'AI couldn’t answer' : 'Wants a person'}
                </Badge>
              ) : (
                c.mode === 'human' && !handler && <Badge variant="success">Team replying</Badge>
              )}
              {handler && <HandlerBadge handler={handler} isMe={handler.id === currentUserId} />}
              {c.conversationId === null && (
                <Badge variant="outline" title="Started through the API, not the help-center chat. Read-only here.">
                  API
                </Badge>
              )}
              <ChevronRightIcon size={16} className="shrink-0 text-muted-foreground" />
            </Link>
            <div className="shrink-0 pr-3">{action(c)}</div>
          </li>
        )
      })}
    </ul>
  )
}

// Who on the team has this conversation, so two people don't reply at once.
export function HandlerBadge({ handler, isMe }: { handler: { name: string }; isMe: boolean }) {
  const initials = initialsOf(handler.name)
  return (
    <Badge variant="success" title={isMe ? 'You’re handling this conversation' : `${handler.name} is handling this conversation`}>
      <span
        className="-ml-1 grid size-4 place-items-center rounded-full bg-success text-[9px] font-semibold text-background"
        aria-hidden="true"
      >
        {initials}
      </span>
      {isMe ? 'You' : handler.name}
    </Badge>
  )
}

// "6 hours", "1 day", "3 days": how long archived conversations are kept.
export function retentionLabel(hours: number): string {
  if (hours % 24 === 0) return `${hours / 24} ${hours === 24 ? 'day' : 'days'}`
  return `${hours} ${hours === 1 ? 'hour' : 'hours'}`
}
