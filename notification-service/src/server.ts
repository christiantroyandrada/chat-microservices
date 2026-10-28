import express, { Express } from 'express'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import cookieParser from 'cookie-parser'
import swaggerUi from 'swagger-ui-express'
import { Server } from 'node:http'
import { errorMiddleware, errorHandler } from './middleware'
import config from './config/config'
import { rabbitMQService } from './services/RabbitMQService'
import { logInfo, logWarn, logError } from './utils/logger'
import { AppDataSource } from './database/connection'
import { NotificationDeliveryWorker } from './services/NotificationDeliveryWorker'
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
    throw new Error('Missing required notification configuration')
  }
  
  // Warn if email credentials are missing (optional but recommended)
  if (!process.env.SMTP_HOST && !process.env.SENDINBLUE_APIKEY) {
    logWarn('[notification-service] WARNING: No email credentials configured (SMTP or SendinBlue)')
  }
}

export const app: Express = express()
const worker = new NotificationDeliveryWorker()
let server: Server | undefined
let startupPromise: Promise<void> | undefined
let shutdownPromise: Promise<void> | undefined
let shuttingDown = false

app.disable('x-powered-by')
// Trust the first proxy hop — required for express-rate-limit to read the
// real client IP via X-Forwarded-For (set by nginx in production).
app.set('trust proxy', 1)

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

app.get('/health', async (_req, res) => {
  try {
    const healthy = !shuttingDown && AppDataSource.isInitialized && rabbitMQService.isHealthy() && worker.isHealthy()
    return res.status(healthy ? 200 : 503).json({ status: healthy ? 'ok' : 'degraded' })
  } catch (err) {
    logError('[notification-service] Health check error:', err)
    return res.status(503).json({ status: 'error' })
  }
})

// Global rate limiter — covers all routes including any future endpoints not under notificationRouter
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: 'Too many requests from this IP, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
})
app.use(globalLimiter)

// Mount notification routes (use plural `/notifications` prefix for consistency)
app.use('/notifications', notificationRouter)

app.use(errorMiddleware)
app.use(errorHandler)

export function start(): Promise<void> {
  if (startupPromise) return startupPromise
  if (shuttingDown) return Promise.reject(new Error('Notification service is shutting down'))
  startupPromise = startResources()
  return startupPromise
}

async function startResources(): Promise<void> {
  try {
    validateEnv()
    await AppDataSource.initialize()
    if (shuttingDown) return
    worker.start()
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => reject(error)
      server = app.listen(config.PORT, () => {
        server?.off('error', failed)
        logInfo(`[notification-service] Server is running on port ${config.PORT}`)
        resolve()
      })
      server.once('error', failed)
    })
    if (shuttingDown) return
    void rabbitMQService.connect().catch(() => logError('[notification-service] Initial RabbitMQ connection failed; recovery remains active'))
  } catch (error) {
    process.exitCode = 1
    // The failing startup must not wait for a shutdown that joins this startup.
    if (!shuttingDown) await requestShutdown('STARTUP_FAILURE', false)
    throw error
  }
}

async function attemptCleanup(work: () => Promise<void>): Promise<void> {
  try { await work() }
  catch (error) {
    process.exitCode = 1
    logError('[notification-service] Cleanup failed:', error)
  }
}

function closeHttp(): Promise<void> {
  const current = server
  server = undefined
  if (!current) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    let finished = false
    const finish = (error?: Error) => {
      if (finished) return
      finished = true
      clearTimeout(timeout)
      if (error) reject(error)
      else resolve()
    }
    const timeout = setTimeout(() => {
      try { current.closeAllConnections() }
      finally { finish(new Error('Notification HTTP drain timed out')) }
    }, 5000)
    timeout.unref?.()
    try {
      current.close(finish)
      current.closeIdleConnections()
    } catch (error) { finish(error as Error) }
  })
}

export function gracefulShutdown(signal: string): Promise<void> {
  return requestShutdown(signal, true)
}

function requestShutdown(signal: string, joinStartup: boolean): Promise<void> {
  if (shutdownPromise) return shutdownPromise
  shuttingDown = true
  logInfo(`[notification-service] ${signal} received. Starting graceful shutdown...`)
  // An unconfirmed provider child can survive completed drains. Clean processes exit naturally.
  const watchdog = setTimeout(() => {
    process.exitCode = 1
    process.exit(1)
  }, 30000)
  watchdog.unref?.()
  const workerStopped = attemptCleanup(() => worker.stop())
  const brokerStopped = attemptCleanup(() => rabbitMQService.disconnect())
  shutdownPromise = (async () => {
    if (joinStartup) await startupPromise?.catch(() => undefined)
    await Promise.all([workerStopped, brokerStopped, attemptCleanup(closeHttp)])
    if (AppDataSource.isInitialized) await attemptCleanup(() => AppDataSource.destroy())
    logInfo('[notification-service] Graceful shutdown complete')
  })()
  return shutdownPromise
}

if (require.main === module) {
  const unexpectedErrorHandler = (error: unknown) => {
    logError('[notification-service] Unexpected error:', error)
    process.exitCode = 1
    void gracefulShutdown('UNEXPECTED_ERROR')
  }
  process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM') })
  process.on('SIGINT', () => { void gracefulShutdown('SIGINT') })
  process.on('uncaughtException', unexpectedErrorHandler)
  process.on('unhandledRejection', unexpectedErrorHandler)
  void start().catch(error => {
    logError('[notification-service] Failed to start:', error)
    process.exitCode = 1
    void gracefulShutdown('STARTUP_FAILURE')
  })
}