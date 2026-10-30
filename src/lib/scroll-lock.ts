// Keeps the page still behind something that covers it (the chat on a phone).
// overflow: hidden alone isn't enough on iOS, where a scroll that reaches the
// end of the chat carries on into the page, so the body is pinned in place
// and put back where it was afterwards. Returns the undo.
export function lockPageScroll(): () => void {
  const { body, documentElement: html } = document
  const y = window.scrollY
  const saved = { html: html.style.overflow, overflow: body.style.overflow, position: body.style.position, top: body.style.top, width: body.style.width }
  html.style.overflow = 'hidden'
  body.style.overflow = 'hidden'
  body.style.position = 'fixed'
  body.style.top = `-${y}px`
  body.style.width = '100%'
  return () => {
    html.style.overflow = saved.html
    body.style.overflow = saved.overflow
    body.style.position = saved.position
    body.style.top = saved.top
    body.style.width = saved.width
    window.scrollTo({ top: y, behavior: 'instant' })
  }
}

// Tailwind's `sm` breakpoint: below it the chat fills the screen.
export const PHONE_QUERY = '(max-width: 639.98px)'
