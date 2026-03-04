/**
 * PresenceStore — distributed presence tracking abstraction (12-factor VI).
 *
 * Architecture:
 *   IPresenceStore         — interface (DIP / SOLID)
 *   LocalPresenceStore     — in-memory fallback (single-node, zero-config)
 *   RedisPresenceStore     — Redis-backed (multi-node, horizontally scalable)
 *
 * The active implementation is chosen at startup based on whether REDIS_URL is
 * set in the environment.  All application code depends only on IPresenceStore,
 * so the backing strategy can be swapped without touching call sites.
 *
 * Design decisions
 * ─────────────────
 * • connect(userId, socketId) → true when this is the user's FIRST active
 *   socket across all nodes (emit online event).
 * • disconnect(userId, socketId) → true when this is the user's LAST active
 *   socket across all nodes (emit offline event).
 * • isOnline(userId) → used by messageHandler to skip RabbitMQ notifications
 *   when the recipient is already receiving messages via WebSocket.
 * • getOnlineUserIds(excludeUserId) → initial bulk presence broadcast on
 *   every new connection (presenceBulk event).
 *
 * Redis key schema
 * ─────────────────
 * ps:sockets:{userId}   SET of socket IDs   TTL 3600s (crash-recovery expiry)
 * ps:online             SET of online userIds (no TTL — managed by connect/disconnect)
 */

import type { Redis } from 'ioredis'
import { logDebug, logError } from '../utils/logger'

// ─── Interface ────────────────────────────────────────────────────────────────

export interface IPresenceStore {
  /** Returns true if this is the user's first connection across all nodes. */
  connect(userId: string, socketId: string): Promise<boolean>
  /** Returns true if this is the user's last connection across all nodes. */
  disconnect(userId: string, socketId: string): Promise<boolean>
  /** Check if a user is currently online (used by messageHandler). */
  isOnline(userId: string): Promise<boolean>
  /** All currently online userIds, excluding the given userId. */
  getOnlineUserIds(excludeUserId: string): Promise<string[]>
  /** Cleanup — called during graceful shutdown. */
  shutdown(): Promise<void>
}

// ─── Local (in-memory, single-node) ─────────────────────────────────────────

export class LocalPresenceStore implements IPresenceStore {
  /** userId → Set of active socket IDs */
  private readonly sockets = new Map<string, Set<string>>()

  async connect(userId: string, socketId: string): Promise<boolean> {
    if (!this.sockets.has(userId)) {
      this.sockets.set(userId, new Set())
    }
    const set = this.sockets.get(userId)!
    const isFirst = set.size === 0
    set.add(socketId)
    logDebug('[PresenceStore:local] connect', { userId, socketId, isFirst })
    return isFirst
  }

  async disconnect(userId: string, socketId: string): Promise<boolean> {
    const set = this.sockets.get(userId)
    if (!set) return false
    set.delete(socketId)
    const isLast = set.size === 0
    if (isLast) this.sockets.delete(userId)
    logDebug('[PresenceStore:local] disconnect', { userId, socketId, isLast })
    return isLast
  }

  async isOnline(userId: string): Promise<boolean> {
    return (this.sockets.get(userId)?.size ?? 0) > 0
  }

  async getOnlineUserIds(excludeUserId: string): Promise<string[]> {
    const result: string[] = []
    this.sockets.forEach((sockets, uid) => {
      if (uid !== excludeUserId && sockets.size > 0) result.push(uid)
    })
    return result
  }

  /**
   * Periodically compact the Map to reclaim memory freed by deletions.
   * V8 never shrinks a Map's backing store after deletes — rebuild forces GC.
   * Call this every 5 minutes from a setInterval in the process that owns this store.
   */
  compact(): void {
    const fresh = new Map<string, Set<string>>()
    this.sockets.forEach((sockets, uid) => {
      if (sockets.size > 0) fresh.set(uid, sockets)
    })
    this.sockets.clear()
    fresh.forEach((v, k) => this.sockets.set(k, v))
    logDebug('[PresenceStore:local] compacted', { size: this.sockets.size })
  }

  async shutdown(): Promise<void> {
    this.sockets.clear()
  }
}

// ─── Redis (distributed, multi-node) ─────────────────────────────────────────

const KEY_SOCKETS = (userId: string) => `ps:sockets:${userId}`
const KEY_ONLINE = 'ps:online'
const SOCKET_TTL_SECONDS = 3600 // 1-hour TTL for crash-recovery cleanup

export class RedisPresenceStore implements IPresenceStore {
  constructor(private readonly redis: Redis) {}

  async connect(userId: string, socketId: string): Promise<boolean> {
    try {
      // Pipeline: add socket to the user's set + refresh TTL (reset on each new conn)
      // SADD returns 1 for a new member, 0 if already present (idempotent).
      const pipeline = this.redis.pipeline()
      pipeline.sadd(KEY_SOCKETS(userId), socketId)
      pipeline.expire(KEY_SOCKETS(userId), SOCKET_TTL_SECONDS)
      await pipeline.exec()

      // Add to online set and check if this is the first socket
      const count = await this.redis.scard(KEY_SOCKETS(userId))
      if (count === 1) {
        await this.redis.sadd(KEY_ONLINE, userId)
        logDebug('[PresenceStore:redis] connect — first connection', { userId })
        return true
      }
      logDebug('[PresenceStore:redis] connect — additional socket', { userId, count })
      return false
    } catch (err) {
      logError('[PresenceStore:redis] connect error — degrading to offline', err)
      return false
    }
  }

  async disconnect(userId: string, socketId: string): Promise<boolean> {
    try {
      await this.redis.srem(KEY_SOCKETS(userId), socketId)
      const count = await this.redis.scard(KEY_SOCKETS(userId))
      if (count === 0) {
        await this.redis.srem(KEY_ONLINE, userId)
        logDebug('[PresenceStore:redis] disconnect — last connection', { userId })
        return true
      }
      logDebug('[PresenceStore:redis] disconnect — sockets remain', { userId, count })
      return false
    } catch (err) {
      logError('[PresenceStore:redis] disconnect error', err)
      // Treat as "last connection" to avoid stuck-online state
      return true
    }
  }

  async isOnline(userId: string): Promise<boolean> {
    try {
      return (await this.redis.sismember(KEY_ONLINE, userId)) === 1
    } catch (err) {
      logError('[PresenceStore:redis] isOnline error — assuming offline', err)
      return false
    }
  }

  async getOnlineUserIds(excludeUserId: string): Promise<string[]> {
    try {
      const all = await this.redis.smembers(KEY_ONLINE)
      return all.filter(id => id !== excludeUserId)
    } catch (err) {
      logError('[PresenceStore:redis] getOnlineUserIds error — returning empty', err)
      return []
    }
  }

  async shutdown(): Promise<void> {
    // Clients are managed by RedisService; no-op here.
  }
}

// ─── Module-level singleton ───────────────────────────────────────────────────
// Initialised to LocalPresenceStore (no Redis required for development).
// server.ts calls setPresenceStore(redisStore) when REDIS_URL is configured.

let _store: IPresenceStore = new LocalPresenceStore()

export const getPresenceStore = (): IPresenceStore => _store

export const setPresenceStore = (store: IPresenceStore): void => {
  _store = store
}
