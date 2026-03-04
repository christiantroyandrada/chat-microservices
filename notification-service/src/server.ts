import express, { Express } from 'express'
import cors from 'cors'
import helmet from 'helmet'
import cookieParser from 'cookie-parser'
import swaggerUi from 'swagger-ui-express'
import { Server } from 'node:http'
import { errorMiddleware, errorHandler } from './middleware'
import config from './config/config'
import { rabbitMQService } from './services/RabbitMQService'
import { logInfo, logWarn, logError } from './utils/logger'
import { connectDB, runMigrations } from './database'
import notificationRouter from './routes/notificationRoutes'
import { requestLogger } from './middleware/requestLogger'
import { getMetrics, getContentType } from './utils/metrics'
import openapiSpec from './openapi'

// Validate required environment variables on startup
const validateEnv = () => {
  const required = ['PORT', 'MESSAGE_BROKER_URL', 'NOTIFICATIONS_QUEUE', 'DATABASE_URL', 'JWT_SECRET']
  const missing = required.filter(key => !process.env[key])
  
  if (missing.length > 0) {
    logError(`[notification-service] FATAL: Missing required environment variables: ${missing.join(', ')}`)
    process.exit(1)
  }
  
  // Warn if email credentials are missing (optional but recommended)
  if (!process.env.SMTP_HOST && !process.env.SENDINBLUE_APIKEY) {
    logWarn('[notification-service] WARNING: No email credentials configured (SMTP or SendinBlue)')
  }
}

validateEnv()

const app: Express = express()
let server: Server

// CORS must be applied before helmet to ensure preflight requests are handled properly
const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map(o => o.trim())
  : ['http://localhost:5173', 'http://localhost:3000', 'http://localhost:80', 'http://localhost:8080']

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps, curl, Postman)
    if (!origin) return callback(null, true)
    
    if (allowedOrigins.includes(origin)) {
      // Return the origin itself to set Access-Control-Allow-Origin header
      callback(null, origin)
    } else {
      logWarn(`[notification-service] CORS blocked origin: ${origin}`)
      callback(null, false)
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  exposedHeaders: ['Content-Length', 'X-Request-Id'],
  preflightContinue: false,
  optionsSuccessStatus: 204
}))

// ── Security (Factor XV — explicit CSP, OWASP-compliant) ────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  config.env === 'production' ? ["'self'"] : ["'self'", "'unsafe-inline'"],
      styleSrc:   ["'self'", "'unsafe-inline'"],
      imgSrc:     ["'self'", 'data:'],
      fontSrc:    ["'self'"],
      objectSrc:  ["'none'"],
      frameSrc:   ["'none'"],
      baseUri:    ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
    },
  },
  strictTransportSecurity: false,
}))

// ── Observability ────────────────────────────────────────────────────────────
app.use(requestLogger)

// ── API contract (Factor XIII) ───────────────────────────────────────────────
app.get('/api-docs.json', (_req, res) => res.json(openapiSpec))
if (config.env !== 'production') {
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openapiSpec, { explorer: true }))
}

app.get('/metrics', async (_req, res) => {
  try {
    res.set('Content-Type', getContentType())
    res.end(await getMetrics())
  } catch (err) {
    logError('[notification-service] Failed to collect metrics:', err)
    res.status(500).end()
  }
})

// Limit body size
app.use(express.json({ limit: '100kb' }))
app.use(express.urlencoded({ extended: true, parameterLimit: 1000 }))
app.use(cookieParser()) // Parse cookies to read JWT from httpOnly cookies

// Health check endpoint for Docker and monitoring
app.get('/health', async (_req, res) => {
  const checks: Record<string, boolean> = {
    database: false,
    rabbitmq: false
  }
  try {
    const { AppDataSource } = await import('./database/connection')
    checks.database = AppDataSource.isInitialized
    checks.rabbitmq = rabbitMQService.isHealthy()
    const healthy = checks.database && checks.rabbitmq
    return res.status(healthy ? 200 : 503).json({ status: healthy ? 'ok' : 'degraded', service: 'notification-service', checks })
  } catch (err) {
    logError('[notification-service] Health check error:', err)
    return res.status(503).json({ status: 'error', service: 'notification-service', checks, error: String(err) })
  }
})

// Mount notification routes (use plural `/notifications` prefix for consistency)
app.use('/notifications', notificationRouter)

app.use(errorMiddleware)
app.use(errorHandler)

const start = async () => {
  // Connect to database
  await connectDB()
  
  // Run any pending migrations (idempotent - skips already run migrations)
  await runMigrations()

  server = app.listen(config.PORT, () => {
    logInfo(`[notification-service] Server is running on port ${config.PORT}`)
  })

  // Initialize RabbitMQ client for message queue consumption
  await initializeRabbitMQClient()
}

const initializeRabbitMQClient = async () => {
  const maxRetries = 5
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await rabbitMQService.connect()
      logInfo('[notification-service] RabbitMQ client initialized. now listening...')
      return
    } catch (e) {
      if (attempt < maxRetries) {
        const delay = 2000 * attempt
        logWarn(`[notification-service] RabbitMQ connection attempt ${attempt}/${maxRetries} failed, retrying in ${delay}ms...`)
        await new Promise(r => setTimeout(r, delay))
      } else {
        logError(`[notification-service] Failed to initialize RabbitMQ client after all retries: ${e}`)
      }
    }
  }
}

start().catch(err => {
  logError('[notification-service] Failed to start:', err)
  process.exit(1)
})

const gracefulShutdown = async (signal: string) => {
  logInfo(`[notification-service] ${signal} received. Starting graceful shutdown...`)
  try {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      logInfo('[notification-service] HTTP server closed')
    }
    await rabbitMQService.disconnect()
    const { AppDataSource } = await import('./database/connection')
    if (AppDataSource.isInitialized) {
      await AppDataSource.destroy()
      logInfo('[notification-service] Database connection closed')
    }
    logInfo('[notification-service] Graceful shutdown complete')
    process.exit(0)
  } catch (err) {
    logError('[notification-service] Error during graceful shutdown:', err)
    process.exit(1)
  }
}

const unexpectedErrorHandler = (error: unknown) => {
  logError('[notification-service]: Uncaught Exception', error)
  gracefulShutdown('UNCAUGHT_EXCEPTION').catch(() => process.exit(1))
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))
process.on('uncaughtException', unexpectedErrorHandler)
process.on('unhandledRejection', unexpectedErrorHandler)