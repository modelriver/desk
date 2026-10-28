// The message to show for a caught error: its own message when it is an Error,
// otherwise the fallback (or the value as text when there is none).
export function errorMessage(error: unknown, fallback?: string): string {
  if (error instanceof Error) return error.message
  return fallback ?? String(error)
}
