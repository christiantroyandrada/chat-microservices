import { Server } from 'node:http'
import app, { setRedisHealthProvider } from './app'
import { connectDB, runMigrations } from './database'
import config from './config/config'
import { rabbitMQService } from './services/RabbitMQService'
import { createSocketServer } from './websocket'
import { createRedisContext, RedisContext } from './services/RedisService'
import { getPresenceStore, setPresenceStore, LocalPresenceStore } from './services/PresenceStore'

import { logInfo, logWarn, logError } from './utils/logger'

// Validate required environment variables on startup
const validateEnv = () => {
  const required = ['JWT_SECRET', 'DATABASE_URL', 'PORT', 'MESSAGE_BROKER_URL']
  const missing = required.filter(key => !process.env[key])
  
  if (missing.length > 0) {
    logError(`[chat-service] FATAL: Missing required environment variables: ${missing.join(', ')}`)
    process.exit(1)
  }
  
  // Reject weak JWT secrets in production; warn in development
  if (process.env.JWT_SECRET === '{{YOUR_SECRET_KEY}}' || process.env.JWT_SECRET === 'CHANGEME') {
    if (process.env.NODE_ENV === 'production') {
      logError('[chat-service] FATAL: Using default/weak JWT_SECRET in production!')
      process.exit(1)
    }
    logWarn('[chat-service] WARNING: Using default JWT_SECRET. Change this in production!')
  }
}

validateEnv()

let server: Server
let redisContext: RedisContext | undefined
let compactInterval: ReturnType<typeof setInterval> | undefined

const start = async () => {
  // Connect to database
  await connectDB()
  
  // Run any pending migrations (idempotent - skips already run migrations)
  await runMigrations()

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
    // Compact the LocalPresenceStore every 5 min to reclaim memory from V8 Map backing store
    compactInterval = setInterval(() => (getPresenceStore() as LocalPresenceStore).compact(), 5 * 60 * 1000)
  }

  // ensure the RPC/notification client is connected before handling messages
  const maxRetries = 5
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await rabbitMQService.connect()
      logInfo('[chat-service] RabbitMQ client connected')
      break
    } catch (err) {
      if (attempt < maxRetries) {
        const delay = 2000 * attempt
        logWarn(`[chat-service] RabbitMQ connection attempt ${attempt}/${maxRetries} failed, retrying in ${delay}ms...`)
        await new Promise(r => setTimeout(r, delay))
      } else {
        logError('[chat-service] Failed to connect RabbitMQ after all retries:', err)
      }
    }
  }

  server = app.listen(config.PORT, () => {
    logInfo(`[chat-service]: Server is running at port ${config.PORT}`)
  })

  // Initialize Socket.IO with authentication and event handlers
  createSocketServer(server, getPresenceStore(), redisContext)
}

start().catch(err => {
  logError('[chat-service] Failed to start:', err)
  process.exit(1)
})

const gracefulShutdown = async (signal: string) => {
  logInfo(`[chat-service] ${signal} received. Starting graceful shutdown...`)
  try {
    if (compactInterval) clearInterval(compactInterval)
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      logInfo('[chat-service] HTTP server closed')
    }
    await getPresenceStore().shutdown()
    await redisContext?.shutdown()
    await rabbitMQService.disconnect()
    const { AppDataSource } = await import('./database/connection')
    if (AppDataSource.isInitialized) {
      await AppDataSource.destroy()
      logInfo('[chat-service] Database connection closed')
    }
    logInfo('[chat-service] Graceful shutdown complete')
    process.exit(0)
  } catch (err) {
    logError('[chat-service] Error during graceful shutdown:', err)
    process.exit(1)
  }
}

const unexpectedErrorHandler = (error: unknown) => {
  logError('[chat-service]: Uncaught Exception', error)
  gracefulShutdown('UNCAUGHT_EXCEPTION').catch(() => process.exit(1))
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))
process.on('uncaughtException', unexpectedErrorHandler)
process.on('unhandledRejection', unexpectedErrorHandler)