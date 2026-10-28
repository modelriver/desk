import { isIP } from 'node:net'

export interface ClientIpConfig {
  // Number of reverse proxies in front of the app that append to
  // X-Forwarded-For (nginx = 1, Cloudflare -> nginx = 2). 0 ignores the header.
  trustedHops: number
  // A header set by a proxy you trust that holds the client IP, such as
  // cf-connecting-ip. Takes precedence over X-Forwarded-For when present.
  clientIpHeader: string
}

// Picks the client IP for rate limiting. Never uses the first X-Forwarded-For
// entry: clients can send that header themselves, and proxies append to it, so
// only the entries added by our own proxies (counted from the right) are trusted.
export function pickClientIp(
  headers: { get(name: string): string | null },
  socketIp: string | undefined,
  config: ClientIpConfig,
): string {
  if (config.clientIpHeader) {
    const value = headers.get(config.clientIpHeader)?.trim()
    if (value && isIP(value)) return normalize(value)
  }
  if (config.trustedHops > 0) {
    const entries = (headers.get('x-forwarded-for') ?? '')
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean)
    // The right-most entry was added by the proxy closest to us, and so on.
    const candidate = entries[entries.length - config.trustedHops]
    if (candidate && isIP(candidate)) return normalize(candidate)
  }
  return socketIp ? normalize(socketIp) : 'unknown'
}

// Group IPv6 clients by /64 (one customer usually controls a whole /64), and
// unwrap IPv4-mapped IPv6 addresses.
function normalize(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)
  if (mapped) return mapped[1]!
  if (isIP(ip) !== 6) return ip
  return `${expandV6(ip).slice(0, 4).join(':')}::/64`
}

function expandV6(ip: string): string[] {
  const [head = '', tail = ''] = ip.split('::')
  const h = head ? head.split(':') : []
  const t = tail ? tail.split(':') : []
  const missing = ip.includes('::') ? 8 - h.length - t.length : 0
  return [...h, ...Array<string>(missing).fill('0'), ...t].map((p) => p.toLowerCase().replace(/^0+(?=.)/, ''))
}
