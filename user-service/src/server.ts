import 'reflect-metadata'
import express, { Express } from 'express'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import cookieParser from 'cookie-parser'
import swaggerUi from 'swagger-ui-express'
import { Server } from 'node:http'
import userServiceRouter from './routes/userServiceRouter'
import { errorMiddleware, errorHandler } from './middleware'
import { requestLogger } from './middleware/requestLogger'
import { connectDB } from './database'
import config from './config/config'
import { rabbitMQService } from './services/RabbitMQService'
import { logInfo, logWarn, logError } from './utils/logger'
import { getMetrics, getContentType } from './utils/metrics'
import openapiSpec from './openapi'

// Validate required environment variables on startup
const validateEnv = () => {
  const required = ['JWT_SECRET', 'DATABASE_URL', 'PORT', 'MESSAGE_BROKER_URL']
  const missing = required.filter(key => !process.env[key])
  
  if (missing.length > 0) {
    logError(`[user-service] FATAL: Missing required environment variables: ${missing.join(', ')}`)
    process.exit(1)
  }
  
  // Fail hard on default/weak secrets in production
  const isProduction = process.env.NODE_ENV === 'production'
  const weakSecrets = new Set(['{{YOUR_SECRET_KEY}}', 'CHANGEME', 'changeme', 'test', 'secret'])
  const jwtSecret = process.env.JWT_SECRET || ''
  
  if (isProduction && (jwtSecret.length < 32 || weakSecrets.has(jwtSecret))) {
    logError('[user-service] FATAL: Running in production with weak/default JWT_SECRET. Aborting.')
    logError('[user-service] JWT_SECRET must be at least 32 characters and not a default value.')
    process.exit(1)
  }
  
  if (!isProduction && weakSecrets.has(jwtSecret)) {
    logWarn('[user-service] WARNING: Using default JWT_SECRET. Change this before deploying to production!')
  }
}

validateEnv()

const app: Express = express()
let server: Server

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
const startServer = async () => {
  try {
    // Connect to database (as the non-superuser runtime role user_svc)
    await connectDB()

    // NOTE: migrations are applied by the dedicated `user-migrate` step (as
    // admin) before this service starts — the runtime role has no DDL rights.

    // Start HTTP server
    server = app.listen(config.PORT, () => {
      logInfo(`User Service is running on port ${config.PORT}`)
    })
    
    // RabbitMQ owns recovery, so HTTP remains available while the broker is offline.
    initRabbitMQClient()
  } catch (error) {
    logError('[user-service] Failed to start server:', error)
    process.exit(1)
  }
}

const initRabbitMQClient = async () => {
  try { await rabbitMQService.connect(); logInfo('[user-service] RabbitMQ client initialized. now listening...') }
  catch (error) { logError('[user-service] RabbitMQ initial connection failed; recovery is scheduled:', error) }
}

// Start the server
startServer()

let shutdownPromise: Promise<void> | undefined
const gracefulShutdown = (signal: string): Promise<void> => {
  if (shutdownPromise) return shutdownPromise
  shutdownPromise = (async () => {
  logInfo(`[user-service] ${signal} received. Starting graceful shutdown...`)
  let failed = false
  try { if (server) await new Promise<void>((resolve) => server.close(() => resolve())) } catch (error) { failed = true; logError('[user-service] HTTP shutdown failed:', error) }
  try { await rabbitMQService.disconnect() } catch (error) { failed = true; logError('[user-service] RabbitMQ shutdown failed:', error) }
  try {
    const { AppDataSource } = await import('./database/connection')
    if (AppDataSource.isInitialized) await AppDataSource.destroy()
  } catch (error) { failed = true; logError('[user-service] Database shutdown failed:', error) }
  logInfo('[user-service] Graceful shutdown complete')
  process.exit(failed ? 1 : 0)
  })()
  return shutdownPromise
}

const unexpectedErrorHandler = (error: unknown) => {
  logError('[user-service]: Uncaught Exception', error)
  void gracefulShutdown('UNCAUGHT_EXCEPTION').catch((shutdownError) => logError('[user-service] Shutdown failed:', shutdownError))
}

process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM').catch((error) => logError('[user-service] Shutdown failed:', error)) })
process.on('SIGINT', () => { void gracefulShutdown('SIGINT').catch((error) => logError('[user-service] Shutdown failed:', error)) })
process.on('uncaughtException', unexpectedErrorHandler)
process.on('unhandledRejection', unexpectedErrorHandler)
