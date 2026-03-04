/**
 * RedisService — ioredis client management for Socket.IO adapter (12-factor VI).
 *
 * Responsibilities:
 *   • Create and own three ioredis clients (pub / sub / presence).
 *   • Expose a Socket.IO adapter factory (pub+sub clients).
 *   • Expose a RedisPresenceStore bound to the presence client.
 *   • Track connection health for the /health endpoint.
 *   • Emit Prometheus metrics for Redis connection state.
 *   • Graceful shutdown: quit all three clients.
 *
 * Graceful-degradation strategy
 * ──────────────────────────────
 * This service is OPTIONAL.  When REDIS_URL is not set, the caller (server.ts)
 * skips initialising Redis and the system runs in single-node in-memory mode.
 * If Redis becomes unavailable after startup, ioredis retries automatically;
 * the PresenceStore catches errors and degrades gracefully on each operation.
 *
 * OWASP note: the Redis URL is supplied via environment variable (never logged).
 */

import Redis from 'ioredis'
import { createAdapter } from '@socket.io/redis-adapter'
import { RedisPresenceStore, type IPresenceStore } from './PresenceStore'
import { logInfo, logWarn, logError } from '../utils/logger'
import { redisConnectedGauge } from '../utils/metrics'

export interface RedisContext {
  /** Pass this to io.adapter() when constructing the Socket.IO server. */
  adapterFactory: ReturnType<typeof createAdapter>
  /** Distributed presence store bound to the presence Redis client. */
  presenceStore: IPresenceStore
  /** Whether the Redis connection is currently healthy. */
  isHealthy(): boolean
  /** Quit all clients cleanly during graceful shutdown. */
  shutdown(): Promise<void>
}

/** Create and connect three ioredis clients, returning a RedisContext. */
export async function createRedisContext(url: string): Promise<RedisContext> {
  // Three separate clients: pub and sub must not share one connection because
  // a subscribed client cannot issue non-pub/sub commands.
  const pub = createClient(url, 'pub')
  const sub = createClient(url, 'sub')
  const presence = createClient(url, 'presence')

  let healthy = false

  // ioredis connects lazily — wait for `ready` before handing off
  await Promise.all([waitReady(pub, 'pub'), waitReady(sub, 'sub'), waitReady(presence, 'presence')])
  healthy = true
  redisConnectedGauge.set(1)
  logInfo('[RedisService] All clients ready')

  // Track disconnects for health check + metrics
  for (const [client, name] of [[pub, 'pub'], [sub, 'sub'], [presence, 'presence']] as const) {
    client.on('close', () => {
      healthy = false
      redisConnectedGauge.set(0)
      logWarn(`[RedisService] client ${name} closed`)
    })
    client.on('ready', () => {
      // Re-evaluate health: all three must be ready
      healthy = pub.status === 'ready' && sub.status === 'ready' && presence.status === 'ready'
      if (healthy) {
        redisConnectedGauge.set(1)
        logInfo(`[RedisService] client ${name} reconnected`)
      }
    })
  }

  return {
    adapterFactory: createAdapter(pub, sub),
    presenceStore: new RedisPresenceStore(presence),
    isHealthy: () => healthy,
    shutdown: async () => {
      logInfo('[RedisService] Shutting down Redis clients…')
      await Promise.allSettled([pub.quit(), sub.quit(), presence.quit()])
      logInfo('[RedisService] Redis clients closed')
    },
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createClient(url: string, role: string): Redis {
  const client = new Redis(url, {
    // Let ioredis manage reconnection — don't crash the process on initial failure.
    // Default strategy: exponential backoff up to 2000 ms.
    retryStrategy: (times: number) => Math.min(times * 100, 2000),
    // Required for pub/sub clients: do not auto-resubscribe (adapter handles it).
    autoResubscribe: role !== 'sub',
    lazyConnect: true,
    enableReadyCheck: true,
    // Don't log credentials — only use for debugging connection issues
    showFriendlyErrorStack: process.env.NODE_ENV !== 'production',
  })

  client.on('error', (err: Error) => {
    // Log but do NOT crash — ioredis retries automatically
    logError(`[RedisService:${role}] error`, err.message)
  })

  return client
}

async function waitReady(client: Redis, role: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`[RedisService:${role}] connection timed out after 5s`))
    }, 5000)

    client.once('ready', () => {
      clearTimeout(timeout)
      logInfo(`[RedisService:${role}] connected`)
      resolve()
    })
    client.once('error', (err: Error) => {
      clearTimeout(timeout)
      // Don't reject here — let ioredis retry; if first connect fails we reject via timeout.
      logWarn(`[RedisService:${role}] initial connection error: ${err.message}`)
    })

    // Trigger the connection
    client.connect().catch(() => {
      // Errors surface via the 'error' event — no double-handling needed
    })
  })
}
