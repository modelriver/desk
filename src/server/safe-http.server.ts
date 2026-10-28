import https from 'node:https'
import dns from 'node:dns'
import net from 'node:net'

// Outbound HTTPS for connectors. Every request:
// - is https only, with no user:password in the URL,
// - refuses private, loopback, link-local (cloud metadata) and other reserved
//   addresses, checked on the addresses the hostname resolves to at connect
//   time, so a hostname can't pass a check and then resolve elsewhere
//   (DNS rebinding),
// - never follows redirects,
// - is cut off after a timeout and a maximum response size.
// allowPrivate (DESK_ALLOW_PRIVATE_CONNECTOR_URLS) lifts the address check
// for an API on your own network; nothing else.

export type HttpFailure = 'invalid_url' | 'blocked' | 'timeout' | 'too_large' | 'redirect' | 'network'

export class SafeHttpError extends Error {
  kind: HttpFailure
  constructor(kind: HttpFailure, message: string) {
    super(message)
    this.kind = kind
  }
}

export interface SafeRequest {
  url: string
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
  maxBytes?: number
  allowPrivate?: boolean
}

export interface SafeResponse {
  status: number
  text: string
  // undefined when the body isn't JSON.
  json: unknown
}

export type RequestFn = (req: SafeRequest) => Promise<SafeResponse>
export type Resolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>

export interface HttpDeps {
  resolve?: Resolver
  // Extra trusted CA, for tests against a local HTTPS server.
  ca?: string | Buffer
}

export const DEFAULT_TIMEOUT_MS = 8_000
export const DEFAULT_MAX_BYTES = 64 * 1024

// Separate lists: a BlockList also checks IPv4 addresses against its IPv6
// rules (as ::ffff:a.b.c.d), so one list blocking IPv4-mapped addresses
// would block every IPv4 address.
const blockedV4 = new net.BlockList()
const blockedV6 = new net.BlockList()
for (const [prefix, bits] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, including cloud metadata (169.254.169.254)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, including 255.255.255.255
] as const) {
  blockedV4.addSubnet(prefix, bits, 'ipv4')
}
for (const [prefix, bits] of [
  ['::', 96], // unspecified, loopback (::1) and IPv4-compatible addresses
  ['::ffff:0:0', 96], // IPv4-mapped: ::ffff:127.0.0.1 is localhost
  ['64:ff9b::', 96], // NAT64, embeds an IPv4 address
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64], // discard
  ['2001::', 32], // Teredo, embeds an IPv4 address
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4, embeds an IPv4 address
  ['fc00::', 7], // unique local (private)
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8], // multicast
] as const) {
  blockedV6.addSubnet(prefix, bits, 'ipv6')
}

// Anything that isn't a valid IP counts as blocked.
export function isBlockedAddress(address: string): boolean {
  const family = net.isIP(address)
  if (family === 4) return blockedV4.check(address, 'ipv4')
  if (family === 6) return blockedV6.check(address, 'ipv6')
  return true
}

export function parseHttpsUrl(raw: string): URL {
  if (raw.length > 2000) throw new SafeHttpError('invalid_url', 'The URL is too long.')
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new SafeHttpError('invalid_url', 'That isn’t a valid URL.')
  }
  if (url.protocol !== 'https:') throw new SafeHttpError('invalid_url', 'The URL must start with https://.')
  if (url.username || url.password) throw new SafeHttpError('invalid_url', 'Put credentials in the key fields, not in the URL.')
  if (!url.hostname) throw new SafeHttpError('invalid_url', 'The URL has no host.')
  return url
}

const systemResolve: Resolver = (hostname) => dns.promises.lookup(hostname, { all: true, verbatim: true })

function blockedMessage(host: string, address: string): string {
  return `${host} resolves to a private or reserved address (${address}). Connectors can’t reach those unless DESK_ALLOW_PRIVATE_CONNECTOR_URLS=true.`
}

export async function safeRequest(req: SafeRequest, deps: HttpDeps = {}): Promise<SafeResponse> {
  const url = parseHttpsUrl(req.url)
  const host = url.hostname.replace(/^\[|\]$/g, '')
  // A literal IP never goes through lookup, so it's checked here.
  if (net.isIP(host) && !req.allowPrivate && isBlockedAddress(host)) {
    throw new SafeHttpError('blocked', blockedMessage(host, host))
  }
  const resolve = deps.resolve ?? systemResolve
  const lookup = ((hostname: string, options: dns.LookupOptions, callback: (...args: unknown[]) => void) => {
    resolve(hostname)
      .then((addresses) => {
        if (!addresses.length) throw new SafeHttpError('network', `${hostname} has no address.`)
        if (!req.allowPrivate) {
          const bad = addresses.find((a) => isBlockedAddress(a.address))
          if (bad) throw new SafeHttpError('blocked', blockedMessage(hostname, bad.address))
        }
        if (options.all) callback(null, addresses)
        else callback(null, addresses[0]!.address, addresses[0]!.family)
      })
      .catch((err) => callback(err))
  }) as unknown as net.LookupFunction

  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = req.maxBytes ?? DEFAULT_MAX_BYTES
  const headers: Record<string, string> = { 'user-agent': 'Desk-Connector/1', accept: 'application/json', ...req.headers }
  if (req.body !== undefined) headers['content-length'] = String(Buffer.byteLength(req.body))

  return new Promise<SafeResponse>((resolvePromise, reject) => {
    let settled = false
    const fail = (err: unknown) => {
      if (settled) return
      settled = true
      reject(toSafeError(err, url.host, timeoutMs))
    }
    const request = https.request(
      url,
      {
        method: req.method ?? 'GET',
        headers,
        lookup,
        ca: deps.ca,
        // A fresh connection each time, so every request is checked again.
        agent: false,
        signal: AbortSignal.timeout(timeoutMs),
      },
      (res) => {
        const status = res.statusCode ?? 0
        if (status >= 300 && status < 400) {
          res.resume()
          request.destroy()
          return fail(new SafeHttpError('redirect', `${url.host} answered with a redirect (${status}). Connectors don’t follow redirects; use the final URL.`))
        }
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > maxBytes) {
            request.destroy()
            return fail(new SafeHttpError('too_large', `${url.host} sent more than ${Math.round(maxBytes / 1024)} KB.`))
          }
          chunks.push(chunk)
        })
        res.on('end', () => {
          if (settled) return
          settled = true
          const text = Buffer.concat(chunks).toString('utf8')
          let json: unknown
          try {
            json = text ? JSON.parse(text) : undefined
          } catch {
            json = undefined
          }
          resolvePromise({ status, text, json })
        })
        res.on('error', fail)
      },
    )
    request.on('error', fail)
    if (req.body !== undefined) request.write(req.body)
    request.end()
  })
}

function toSafeError(err: unknown, host: string, timeoutMs: number): SafeHttpError {
  if (err instanceof SafeHttpError) return err
  const name = err instanceof Error ? err.name : ''
  if (name === 'AbortError' || name === 'TimeoutError') {
    return new SafeHttpError('timeout', `${host} didn’t answer within ${Math.round(timeoutMs / 1000)} seconds.`)
  }
  const code = (err as { code?: string } | null)?.code
  return new SafeHttpError('network', `Couldn’t reach ${host}${code ? ` (${code})` : ''}.`)
}

export function requestFn(deps: HttpDeps = {}): RequestFn {
  return (req) => safeRequest(req, deps)
}
