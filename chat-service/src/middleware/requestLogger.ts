import type { Request, Response, NextFunction } from 'express'
import { randomUUID } from 'node:crypto'
import { httpRequestsTotal, httpRequestDurationSeconds } from '../utils/metrics'
import { logInfo } from '../utils/logger'

// Only accept request IDs that are valid UUID v4 strings.
// Rejects any header value that could be used for log injection
// (newlines, overlong strings, shell metacharacters, etc.).
// OWASP A03: validates untrusted header before it reaches our logs.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Express middleware that:
 *  1. Assigns an X-Request-ID to every request (reads existing header if valid UUID, else generates).
 *  2. Logs each HTTP request on response finish (method, path, status, duration).
 *  3. Records Prometheus HTTP counter + duration histogram.
 *
 * Mount early — before routes but after CORS/helmet — so all requests are captured.
 * Health-check requests (/health) are counted in Prometheus but NOT written to logs
 * to avoid flooding stdout with scrape noise.
 */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const incomingId = req.headers['x-request-id'] as string | undefined
  // Reject any header that does not match UUID v4 format to prevent log injection
  const requestId = incomingId && UUID_RE.test(incomingId) ? incomingId : randomUUID()

  // Propagate request ID so downstream code can include it in log entries
  req.headers['x-request-id'] = requestId
  res.setHeader('X-Request-ID', requestId)

  const startHr = process.hrtime.bigint()

  res.on('finish', () => {
    const durationSec = Number(process.hrtime.bigint() - startHr) / 1e9

    // Use matched route pattern (e.g. "/messages/:id") to avoid high-cardinality
    // labels from raw path params. Falls back to "unmatched" for 404 responses.
    const route: string = (req.route?.path as string | undefined) ?? 'unmatched'
    const labels = {
      method: req.method,
      route,
      status_code: String(res.statusCode),
    }

    httpRequestsTotal.inc(labels)
    httpRequestDurationSeconds.observe(labels, durationSec)

    // Suppress health-check chatter; everything else gets an access log line
    if (req.path !== '/health') {
      logInfo({
        type: 'http',
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration_ms: Math.round(durationSec * 1000),
        request_id: requestId,
      })
    }
  })

  next()
}
