import * as promClient from 'prom-client'

// ── Default Node.js process metrics ─────────────────────────────────────────
// Collects: heap memory, CPU, event-loop lag, GC, active handles/requests.
// Prometheus `job` label (set by scrape config) identifies which service.
// Guard against double-registration (module hot-reload / test environments).
if (!promClient.register.getSingleMetric('nodejs_version_info')) {
  promClient.collectDefaultMetrics({ prefix: 'nodejs_' })
}

// ── HTTP metrics (shared across all services) ────────────────────────────────
function getOrCreateCounter(
  name: string,
  help: string,
  labelNames: string[],
): promClient.Counter {
  return (
    (promClient.register.getSingleMetric(name) as promClient.Counter | undefined) ??
    new promClient.Counter({ name, help, labelNames })
  )
}

function getOrCreateHistogram(
  name: string,
  help: string,
  labelNames: string[],
  buckets: number[],
): promClient.Histogram {
  return (
    (promClient.register.getSingleMetric(name) as promClient.Histogram | undefined) ??
    new promClient.Histogram({ name, help, labelNames, buckets })
  )
}

function getOrCreateGauge(name: string, help: string): promClient.Gauge {
  return (
    (promClient.register.getSingleMetric(name) as promClient.Gauge | undefined) ??
    new promClient.Gauge({ name, help })
  )
}

export const httpRequestsTotal: promClient.Counter = getOrCreateCounter(
  'http_requests_total',
  'Total number of HTTP requests',
  ['method', 'route', 'status_code'],
)

export const httpRequestDurationSeconds: promClient.Histogram = getOrCreateHistogram(
  'http_request_duration_seconds',
  'HTTP request duration in seconds',
  ['method', 'route', 'status_code'],
  [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
)

// ── Socket.IO metrics (chat-service only) ─────────────────────────────────────
export const socketConnectionsActive: promClient.Gauge = getOrCreateGauge(
  'socket_connections_active',
  'Number of currently active Socket.IO connections',
)

// ── Redis adapter metrics ─────────────────────────────────────────────────────
// 1 when all three Redis clients (pub/sub/presence) are connected, 0 otherwise.
// Lets Grafana alert when Redis goes away and the service falls back to single-node mode.
export const redisConnectedGauge: promClient.Gauge = getOrCreateGauge(
  'redis_adapter_connected',
  'Whether the Socket.IO Redis adapter is currently connected (1=yes, 0=no)',
)

// ── Domain telemetry (Factor XIV) ─────────────────────────────────────────────
// Business-level counters that feed domain-specific dashboards and alerts.
export const chatMessagesSentTotal: promClient.Counter = getOrCreateCounter(
  'chat_messages_sent_total',
  'Total encrypted messages sent',
  ['channel'],
)

export const chatMessagesReadTotal: promClient.Counter = getOrCreateCounter(
  'chat_messages_read_total',
  'Total markAsRead operations',
  [],
)

export const chatPresenceChangesTotal: promClient.Counter = getOrCreateCounter(
  'chat_presence_changes_total',
  'Total presence state transitions emitted',
  ['direction'],
)

// ── Metrics endpoint helpers ──────────────────────────────────────────────────
export async function getMetrics(): Promise<string> {
  return promClient.register.metrics()
}

export function getContentType(): string {
  return promClient.register.contentType
}
