import type { Request, Response, NextFunction } from 'express'
import { randomUUID } from 'node:crypto'
import { httpRequestsTotal, httpRequestDurationSeconds } from '../utils/metrics'
import { logInfo } from '../utils/logger'

// Only accept request IDs that are valid UUID v4 strings.
// Rejects any header value that could be used for log injection.
// OWASP A03: validates untrusted header before it reaches our logs.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Express middleware that:
 *  1. Assigns an X-Request-ID to every request (reads existing header if valid UUID, else generates).
 *  2. Logs each HTTP request on response finish (method, path, status, duration).
 *  3. Records Prometheus HTTP counter + duration histogram.
 */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const incomingId = req.headers['x-request-id'] as string | undefined
  // Reject any header that does not match UUID v4 format to prevent log injection
  const requestId = incomingId && UUID_RE.test(incomingId) ? incomingId : randomUUID()

  req.headers['x-request-id'] = requestId
  res.setHeader('X-Request-ID', requestId)

  const startHr = process.hrtime.bigint()

  res.on('finish', () => {
    const durationSec = Number(process.hrtime.bigint() - startHr) / 1e9

    const route: string = (req.route?.path as string | undefined) ?? 'unmatched'
    const labels = {
      method: req.method,
      route,
      status_code: String(res.statusCode),
    }

    httpRequestsTotal.inc(labels)
    httpRequestDurationSeconds.observe(labels, durationSec)

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
