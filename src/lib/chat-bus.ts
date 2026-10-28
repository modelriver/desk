// Lets any part of the page open the chat widget, optionally sending a
// question straight away (the help-center hero and "Ask a question" buttons).
const EVENT = 'support:open-chat'

export function openChat(text?: string) {
  window.dispatchEvent(new CustomEvent<string | undefined>(EVENT, { detail: text }))
}

export function onOpenChat(handler: (text?: string) => void): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<string | undefined>).detail)
  window.addEventListener(EVENT, listener)
  return () => window.removeEventListener(EVENT, listener)
}
