import 'reflect-metadata'
import express, { Express } from 'express'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import cookieParser from 'cookie-parser'
import swaggerUi from 'swagger-ui-express'
import { createHash, timingSafeEqual } from 'node:crypto'
import { Server } from 'node:http'
import userServiceRouter from './routes/userServiceRouter'
import AuthController from './controllers/AuthController'
import { authenticated } from './middleware/auth'
import { errorMiddleware, errorHandler } from './middleware'
import { requestLogger } from './middleware/requestLogger'
import { connectDB } from './database'
import config from './config/config'
import { rabbitMQService } from './services/RabbitMQService'
import { logInfo, logWarn, logError } from './utils/logger'
import { getMetrics, getContentType } from './utils/metrics'
import openapiSpec from './openapi'

const sessionKey = process.env.GO_WS_SESSION_KEY
const sessionKeyDigest = sessionKey ? createHash('sha256').update(sessionKey).digest() : undefined

// Validate required environment variables on startup
const validateEnv = () => {
  const required = ['JWT_SECRET', 'DATABASE_URL', 'PORT', 'MESSAGE_BROKER_URL']
  const missing = required.filter(key => !process.env[key])
  
  if (missing.length > 0) {
    logError(`[user-service] FATAL: Missing required environment variables: ${missing.join(', ')}`)
    throw new Error('Required environment variables are missing')
  }
  if (sessionKey && Buffer.byteLength(sessionKey) < 32) {
    throw new Error('GO_WS_SESSION_KEY must contain at least 32 bytes')
  }
  
  // Fail hard on default/weak secrets in production
  const isProduction = process.env.NODE_ENV === 'production'
  const weakSecrets = new Set(['{{YOUR_SECRET_KEY}}', 'CHANGEME', 'changeme', 'test', 'secret'])
  const jwtSecret = process.env.JWT_SECRET || ''
  
  if (isProduction && (jwtSecret.length < 32 || weakSecrets.has(jwtSecret))) {
    logError('[user-service] FATAL: Running in production with weak/default JWT_SECRET. Aborting.')
    logError('[user-service] JWT_SECRET must be at least 32 characters and not a default value.')
    throw new Error('Invalid production JWT secret')
  }
  
  if (!isProduction && weakSecrets.has(jwtSecret)) {
    logWarn('[user-service] WARNING: Using default JWT_SECRET. Change this before deploying to production!')
  }
}

const app: Express = express()
let server: Server | undefined
let starting: Promise<void> | undefined

app.disable('x-powered-by')
app.set('trust proxy', 1)
// Configure CORS for the user service. Can be overridden with CORS_ORIGINS env var (comma-separated).
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
      logWarn(`[user-service] CORS blocked origin: ${origin}`)
      callback(null, false)
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  preflightContinue: false,
  optionsSuccessStatus: 204
}))

app.get('/health', async (_req, res) => {
  try {
    const { AppDataSource } = await import('./database/connection')
    const healthy = AppDataSource.isInitialized && rabbitMQService.isHealthy()
    return res.status(healthy ? 200 : 503).json({ status: healthy ? 'ok' : 'degraded' })
  } catch {
    return res.status(503).json({ status: 'error' })
  }
})

app.use(helmet({
  strictTransportSecurity: false,
}))

// ── Observability ────────────────────────────────────────────────────────────
app.use(requestLogger)

app.get('/metrics', async (_req, res) => {
  try {
    res.set('Content-Type', getContentType())
    res.end(await getMetrics())
  } catch (err) {
    logError('[user-service] Failed to collect metrics:', err)
    res.status(500).end()
  }
})

app.use(cookieParser())

// Parse JSON request bodies
app.use(express.json({ limit: '100kb' }))
app.use(express.urlencoded({ extended: true, parameterLimit: 1000 }))

app.get('/internal/ws/session', (req, res, next) => {
  const key = req.get('X-Relay-Session-Key')
  if (!sessionKeyDigest || !key || !timingSafeEqual(sessionKeyDigest, createHash('sha256').update(key).digest())) {
    return res.sendStatus(404)
  }
  if (!req.cookies?.jwt || req.headers.authorization) {
    return res.sendStatus(401)
  }
  res.set('Cache-Control', 'no-store')
  return next()
}, authenticated, AuthController.getCurrentUser)

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests from this IP, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
})
app.use(globalLimiter)
app.use(userServiceRouter)
app.use(errorMiddleware)
app.use(errorHandler)

// Initialize database and run migrations, then start server
export const start = (): Promise<void> => starting ??= (async () => {
  validateEnv()
  // Connect to database (as the non-superuser runtime role user_svc)
  await connectDB()

  // NOTE: migrations are applied by the dedicated `user-migrate` step (as
  // admin) before this service starts — the runtime role has no DDL rights.

  // Start HTTP server
  server = app.listen(config.PORT, () => {
    logInfo(`User Service is running on port ${config.PORT}`)
  })
    
  // RabbitMQ owns recovery, so HTTP remains available while the broker is offline.
  void initRabbitMQClient()
})()

const initRabbitMQClient = async () => {
  try { await rabbitMQService.connect(); logInfo('[user-service] RabbitMQ client initialized. now listening...') }
  catch { logError('[user-service] RabbitMQ initial connection failed; recovery is scheduled') }
}

let shutdownPromise: Promise<void> | undefined
export const gracefulShutdown = (signal: string): Promise<void> => {
  if (shutdownPromise) return shutdownPromise
  shutdownPromise = (async () => {
  logInfo(`[user-service] ${signal} received. Starting graceful shutdown...`)
  await starting?.catch(() => undefined)
  try { if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve())) } catch { process.exitCode = 1; logError('[user-service] HTTP shutdown failed') }
  try { await rabbitMQService.disconnect() } catch { process.exitCode = 1; logError('[user-service] RabbitMQ shutdown failed') }
  try {
    const { AppDataSource } = await import('./database/connection')
    if (AppDataSource.isInitialized) await AppDataSource.destroy()
  } catch { process.exitCode = 1; logError('[user-service] Database shutdown failed') }
  logInfo('[user-service] Graceful shutdown complete')
  })()
  return shutdownPromise
}

const unexpectedErrorHandler = (error: unknown) => {
  logError('[user-service]: Uncaught Exception', error)
  process.exitCode = 1
  void gracefulShutdown('UNCAUGHT_EXCEPTION').catch((shutdownError) => logError('[user-service] Shutdown failed:', shutdownError))
}

process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM').catch((error) => logError('[user-service] Shutdown failed:', error)) })
process.on('SIGINT', () => { void gracefulShutdown('SIGINT').catch((error) => logError('[user-service] Shutdown failed:', error)) })
process.on('uncaughtException', unexpectedErrorHandler)
process.on('unhandledRejection', unexpectedErrorHandler)

if (require.main === module) {
  start().catch(() => {
    process.exitCode = 1
    logError('[user-service] Failed to start server')
    void gracefulShutdown('STARTUP_FAILURE').catch(() => { process.exitCode = 1 })
  })
}
