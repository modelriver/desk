// Production server: serves the built client assets and hands everything else
// to the TanStack Start fetch handler. Plain node:http, no framework.
//   npm run build && npm start
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import handler from './dist/server/server.js'
import { checkSiteConfig, readSiteConfigFile } from './src/server/site-config.server.ts'
import { fontCspSources } from './src/lib/site-config.ts'
import { BRAND_ASSET_CSP } from './src/server/branding.server.ts'
import { scheduleCleanup } from './src/server/archive.server.ts'

const PORT = Number(process.env.PORT ?? 3000)
const HOST = process.env.HOST ?? '127.0.0.1'
const CLIENT_DIR = path.resolve('dist/client')
const MAX_BODY = 2 * 1024 * 1024
// Sites allowed to embed /widget in an iframe. Only this site unless you list yours.
const WIDGET_FRAME_ANCESTORS = process.env.WIDGET_FRAME_ANCESTORS || "'self'"

// Browsers stream answers straight from ModelRiver's websocket, so allow that origin.
const apiUrl = new URL(process.env.MODELRIVER_API_URL || 'https://api.modelriver.com/v1')
const wsOrigin = `${apiUrl.protocol === 'http:' ? 'ws' : 'wss'}://${apiUrl.host}`

// Font stylesheets and files named in support.config.json. Reading it here
// also fails startup early if the file is invalid.
const fontSources = fontCspSources(readSiteConfigFile())
// Also checks that the logo files in the config exist and are SVGs.
checkSiteConfig()
// Google Fonts is always allowed: the fonts picked in Settings come from it,
// and they can change without a restart.
const styleSrc = [...new Set(["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', ...fontSources.style])].join(' ')
const fontSrc = [...new Set(["'self'", 'data:', 'https://fonts.gstatic.com', ...fontSources.font])].join(' ')

const TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
}

function securityHeaders(pathname) {
  const frameAncestors = pathname === '/widget' ? WIDGET_FRAME_ANCESTORS : "'self'"
  // Uploaded logos and favicons: nothing in an SVG opened directly may run.
  if (pathname.startsWith('/brand/')) {
    return {
      'Content-Security-Policy': BRAND_ASSET_CSP,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Strict-Transport-Security': 'max-age=31536000',
    }
  }
  return {
    'Content-Security-Policy': [
      "default-src 'self'",
      // TanStack Start inlines its hydration bootstrap. Nonces are on the README roadmap.
      "script-src 'self' 'unsafe-inline'",
      `style-src ${styleSrc}`,
      `font-src ${fontSrc}`,
      "img-src 'self' data: https:",
      `connect-src 'self' ${wsOrigin}`,
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      `frame-ancestors ${frameAncestors}`,
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    // Ignored by browsers over plain http, so it's safe on localhost too. No
    // includeSubDomains: other sites on the same domain may not use HTTPS.
    'Strict-Transport-Security': 'max-age=31536000',
  }
}

function plainText(res, status, text, pathname = '/') {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...securityHeaders(pathname) }).end(text)
}

// Serves a built file under /assets/. Returns false when the path isn't one,
// so the request falls through to the app (which answers 404).
async function serveStatic(req, res, pathname) {
  if (!pathname.startsWith('/assets/')) return false
  let decoded
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    plainText(res, 400, 'Bad Request', pathname)
    return true
  }
  const file = path.resolve(CLIENT_DIR, '.' + decoded)
  if (!file.startsWith(CLIENT_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false
  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream',
    'Cache-Control': 'public, max-age=31536000, immutable',
    ...securityHeaders(pathname),
  })
  if (req.method === 'HEAD') res.end()
  else await pipeline(fs.createReadStream(file), res)
  return true
}

function limitBody(max) {
  let seen = 0
  return new Transform({
    transform(chunk, _enc, cb) {
      seen += chunk.length
      cb(seen > max ? new Error('Request body too large') : null, chunk)
    },
  })
}

// Check for timed-out connections every 5 s (Node's default is 30 s).
const server = http.createServer({ connectionsCheckingInterval: 5_000 }, async (req, res) => {
  let url
  try {
    // A malformed Host header (or request target) makes this throw.
    url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  } catch {
    plainText(res, 400, 'Bad Request')
    return
  }
  try {
    if ((req.method === 'GET' || req.method === 'HEAD') && (await serveStatic(req, res, url.pathname))) return

    if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) {
      plainText(res, 413, 'Request body too large', url.pathname)
      return
    }
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
    const request = new Request(url, {
      method: req.method,
      headers: Object.entries(req.headers).flatMap(([k, v]) =>
        v === undefined ? [] : Array.isArray(v) ? v.map((x) => [k, x]) : [[k, v]],
      ),
      body: hasBody ? Readable.toWeb(req.pipe(limitBody(MAX_BODY))) : undefined,
      duplex: hasBody ? 'half' : undefined,
    })
    // Read by getRequestIP() for rate limiting.
    Object.defineProperty(request, 'ip', { value: req.socket.remoteAddress })

    const response = await handler.fetch(request)
    // Response headers come lowercased; match them so ours replace the app's
    // instead of being sent twice.
    const ours = Object.entries(securityHeaders(url.pathname)).map(([k, v]) => [k.toLowerCase(), v])
    const headers = { ...Object.fromEntries(response.headers), ...Object.fromEntries(ours) }
    const cookies = response.headers.getSetCookie()
    if (cookies.length) headers['set-cookie'] = cookies
    res.writeHead(response.status, response.statusText, headers)
    if (response.body && req.method !== 'HEAD') await pipeline(Readable.fromWeb(response.body), res)
    else res.end()
  } catch (err) {
    console.error(err)
    if (res.headersSent) res.destroy()
    else plainText(res, 500, 'Internal Server Error', url.pathname)
  }
})

// Don't let slow or idle clients hold sockets open (slowloris-style floods).
// Answers stream from ModelRiver's websocket, not through this server, so
// every request here is short.
server.headersTimeout = 15_000 // to receive all request headers
server.requestTimeout = 30_000 // to receive the whole request, body included
server.keepAliveTimeout = 5_000 // idle keep-alive connections
server.timeout = 60_000 // any socket with no activity
server.maxRequestsPerSocket = 1_000

server.listen(PORT, HOST, () => console.log(`desk listening on http://${HOST}:${PORT}`))

// Hourly: archived conversations past ARCHIVE_RETENTION_HOURS, old insights, expired sign-ins.
scheduleCleanup()

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
