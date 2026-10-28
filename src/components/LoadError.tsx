import { useEffect } from 'react'
import { useRouter } from '@tanstack/react-router'
import { errorMessage } from '../lib/errors.ts'
import { Button } from './ui.tsx'
import { RefreshIcon } from './icons.tsx'

// Error view for dashboard loaders that read from ModelRiver. Retries on its
// own every few seconds so a brief outage doesn't leave the page stuck.
export function LoadError({ title, error }: { title: string; error: unknown }) {
  const router = useRouter()
  useEffect(() => {
    const timer = setInterval(() => void router.invalidate(), 10_000)
    return () => clearInterval(timer)
  }, [router])
  return (
    <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 p-5">
      <p className="font-medium">{title}</p>
      <p className="mt-1 text-sm text-muted-foreground">{errorMessage(error).replace(/\.$/, '')}. Retrying automatically.</p>
      <Button variant="outline" size="sm" className="mt-4" onClick={() => void router.invalidate()}>
        <RefreshIcon size={14} />
        Retry now
      </Button>
    </div>
  )
}
