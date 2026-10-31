import { createFileRoute, redirect } from '@tanstack/react-router'

// Ticket links in emails sent before the customer portal: same ticket, same key.
export const Route = createFileRoute('/tickets/$ticketRef')({
  validateSearch: (search: Record<string, unknown>): { k?: string } =>
    typeof search.k === 'string' && search.k.length <= 100 ? { k: search.k } : {},
  beforeLoad: ({ params, search }) => {
    throw redirect({ to: '/customer-portal/tickets/$ticketRef', params: { ticketRef: params.ticketRef }, search, replace: true })
  },
})
