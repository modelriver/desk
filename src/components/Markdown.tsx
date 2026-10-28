import { renderChatMarkdown, renderMarkdown } from '../lib/markdown.ts'
import { cn } from '../lib/cn.ts'

// Safe to inject: markdown-it runs with html disabled and validates link URLs.
// `chat` is for AI answers and replies, which never render images.
export function Markdown({ source, className, chat }: { source: string; className?: string; chat?: boolean }) {
  const html = chat ? renderChatMarkdown(source) : renderMarkdown(source)
  return <div className={cn('prose', className)} dangerouslySetInnerHTML={{ __html: html }} />
}
