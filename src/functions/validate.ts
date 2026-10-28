// Hand-written input validation for server functions (no schema library).

export function asObject(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid input.')
  return input as Record<string, unknown>
}

export function str(input: Record<string, unknown>, key: string, opts: { min?: number; max: number }): string {
  const value = input[key]
  if (typeof value !== 'string') throw new Error(`${key} is required.`)
  const trimmed = value.trim()
  if (trimmed.length < (opts.min ?? 1)) throw new Error(`${key} is too short.`)
  if (trimmed.length > opts.max) throw new Error(`${key} is too long.`)
  return trimmed
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function uuid(input: Record<string, unknown>, key: string): string {
  const value = input[key]
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error(`${key} is invalid.`)
  return value.toLowerCase()
}

export function oneOf<T extends string>(input: Record<string, unknown>, key: string, values: readonly T[]): T {
  const value = input[key]
  if (typeof value !== 'string' || !values.includes(value as T)) throw new Error(`${key} is invalid.`)
  return value as T
}
