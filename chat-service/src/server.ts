import { Server } from 'node:http'
import type { Server as SocketIOServer } from 'socket.io'
import app, { setRedisHealthProvider } from './app'
import { connectDB } from './database'
import config from './config/config'
import { rabbitMQService } from './services/RabbitMQService'
import { outboxWorker } from './services/OutboxWorker'
import { createSocketServer } from './websocket'
import { createRedisContext, RedisContext } from './services/RedisService'
import { getPresenceStore, setPresenceStore } from './services/PresenceStore'
import { AppDataSource } from './database/connection'

import { logInfo, logWarn, logError } from './utils/logger'

// Validate required environment variables on startup
const validateEnv = () => {
  const required = ['JWT_SECRET', 'DATABASE_URL', 'PORT', 'MESSAGE_BROKER_URL']
  const missing = required.filter(key => !process.env[key])
  
  if (missing.length > 0) {
    logError(`[chat-service] FATAL: Missing required environment variables: ${missing.join(', ')}`)
    throw new Error('Required environment variables are missing')
  }
  
  // Reject weak JWT secrets in production; warn in development
  if (process.env.JWT_SECRET === '{{YOUR_SECRET_KEY}}' || process.env.JWT_SECRET === 'CHANGEME') {
    if (process.env.NODE_ENV === 'production') {
      logError('[chat-service] FATAL: Using default/weak JWT_SECRET in production!')
      throw new Error('Invalid production JWT secret')
    }
    logWarn('[chat-service] WARNING: Using default JWT_SECRET. Change this in production!')
  }
}

let server: Server | undefined
let io: SocketIOServer | undefined
let redisContext: RedisContext | undefined
let starting: Promise<Server> | undefined
let shutdown: Promise<void> | undefined

export const start = (): Promise<Server> => starting ??= (async () => {
  validateEnv()
  // Connect to database (as the non-superuser runtime role chat_svc)
  await connectDB()

  // NOTE: migrations are applied by the dedicated `chat-migrate` step (as
  // admin) before this service starts — the runtime role has no DDL rights.

  // ── Redis context (optional — enables horizontal scaling) ─────────────────
  if (config.redisUrl) {
    try {
      redisContext = await createRedisContext(config.redisUrl)
      setPresenceStore(redisContext.presenceStore)
      setRedisHealthProvider(() => redisContext!.isHealthy())
      logInfo('[chat-service] Redis adapter enabled — horizontal scaling active')
    } catch (err) {
      logWarn('[chat-service] Redis init failed, falling back to in-process presence:', err)
    }
  } else {
    logWarn('[chat-service] REDIS_URL not set — running in single-node mode (no horizontal scaling)')
  }

  // RabbitMQService owns reconnects; durable sends do not wait for the broker.
  rabbitMQService.connect().catch(() => logWarn('[chat-service] RabbitMQ unavailable; reconnect scheduled'))
  outboxWorker.start()

  server = app.listen(config.PORT, () => {
    logInfo(`[chat-service]: Server is running at port ${config.PORT}`)
  })

  // Initialize Socket.IO with authentication and event handlers
  io = createSocketServer(server, getPresenceStore(), redisContext)
  return server
})()

export const gracefulShutdown = (signal: string): Promise<void> => shutdown ??= (async () => {
  logInfo(`[chat-service] ${signal} received. Starting graceful shutdown...`)
  await starting?.catch(() => undefined)
  const attempt = async (name: string, cleanup: () => Promise<unknown>) => {
    try { await cleanup() } catch {
      process.exitCode = 1
      logError(`[chat-service] ${name} cleanup failed`)
    }
  }
  await attempt('Socket.IO', async () => { await io?.close() })
  if (server?.listening || (!io && server)) {
    await attempt('HTTP', async () => {
      const closed = new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()))
      server!.closeAllConnections()
      await closed
    })
  }
  await attempt('Outbox worker', () => outboxWorker.stop())
  await attempt('RabbitMQ', () => rabbitMQService.disconnect())
  await attempt('Presence', () => getPresenceStore().shutdown())
  await attempt('Redis', async () => { await redisContext?.shutdown() })
  await attempt('Database', async () => { if (AppDataSource.isInitialized) await AppDataSource.destroy() })
  logInfo('[chat-service] Graceful shutdown complete')
})()

const unexpectedErrorHandler = (error: unknown) => {
  logError('[chat-service]: Uncaught Exception', error)
  process.exitCode = 1
  gracefulShutdown('UNCAUGHT_EXCEPTION').catch(() => { process.exitCode = 1 })
}

process.on('SIGTERM', () => { gracefulShutdown('SIGTERM').catch(() => { process.exitCode = 1 }) })
process.on('SIGINT', () => { gracefulShutdown('SIGINT').catch(() => { process.exitCode = 1 }) })
process.on('uncaughtException', unexpectedErrorHandler)
process.on('unhandledRejection', unexpectedErrorHandler)

if (require.main === module) {
  start().catch(() => {
    logError('[chat-service] Failed to start')
    process.exitCode = 1
    gracefulShutdown('STARTUP_FAILURE').catch(() => { process.exitCode = 1 })
  })
}
