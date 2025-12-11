import { Server } from 'node:http'
import app from './app'
import { connectDB, runMigrations } from './database'
import config from './config/config'
import { rabbitMQService } from './services/RabbitMQService'
import { createSocketServer } from './websocket'

import { logInfo, logWarn, logError } from './utils/logger'

// Validate required environment variables on startup
const validateEnv = () => {
  const required = ['JWT_SECRET', 'DATABASE_URL', 'PORT', 'MESSAGE_BROKER_URL']
  const missing = required.filter(key => !process.env[key])
  
  if (missing.length > 0) {
    logError(`[chat-service] FATAL: Missing required environment variables: ${missing.join(', ')}`)
    process.exit(1)
  }
  
  // Warn about default/weak secrets
  if (process.env.JWT_SECRET === '{{YOUR_SECRET_KEY}}' || process.env.JWT_SECRET === 'CHANGEME') {
    logWarn('[chat-service] WARNING: Using default JWT_SECRET. Change this in production!')
  }
}

validateEnv()

let server: Server

const start = async () => {
  // Connect to database
  await connectDB()
  
  // Run any pending migrations (idempotent - skips already run migrations)
  await runMigrations()

  // ensure the RPC/notification client is connected before handling messages
  try {
    await rabbitMQService.connect()
    logInfo('[chat-service] RabbitMQ client connected')
  } catch (err) {
    logError('[chat-service] Failed to connect RabbitMQ client:', err)
  }

  server = app.listen(config.PORT, () => {
    logInfo(`[chat-service]: Server is running at port ${config.PORT}`)
  })

  // Initialize Socket.IO with authentication and event handlers
  createSocketServer(server)
}

start().catch(err => {
  logError('[chat-service] Failed to start:', err)
  process.exit(1)
})

const exitHandler = () => {
  if (server) {
    server.close(() => {
      logInfo('[chat-service]: Server closed')
      process.exit(1)
    })
  } else {
    process.exit(1)
  }
}

const unexpectedErrorHandler = (error: unknown) => {
  logError('[chat-service]: Uncaught Exception', error)
  exitHandler()
}

process.on('uncaughtException', unexpectedErrorHandler)
process.on('unhandledRejection', unexpectedErrorHandler)