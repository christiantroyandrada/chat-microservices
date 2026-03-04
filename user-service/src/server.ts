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
import { connectDB, runMigrations } from './database'
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
      console.warn(`[user-service] CORS blocked origin: ${origin}`)
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
  const checks: Record<string, boolean> = {
    database: false,
    rabbitmq: false
  }
  try {
    const { AppDataSource } = await import('./database/connection')
    checks.database = AppDataSource.isInitialized
    checks.rabbitmq = rabbitMQService.isHealthy()
    const healthy = checks.database && checks.rabbitmq
    return res.status(healthy ? 200 : 503).json({ status: healthy ? 'ok' : 'degraded', service: 'user-service', checks })
  } catch (err) {
    return res.status(503).json({ status: 'error', service: 'user-service', checks, error: String(err) })
  }
})

app.use(helmet())

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
    // Connect to database
    await connectDB()
    
    // Run any pending migrations (idempotent - skips already run migrations)
    await runMigrations()
    
    // Start HTTP server
    server = app.listen(config.PORT, () => {
      logInfo(`User Service is running on port ${config.PORT}`)
    })
    
    // Initialize RabbitMQ
    await initRabbitMQClient()
  } catch (error) {
    logError('[user-service] Failed to start server:', error)
    process.exit(1)
  }
}

const initRabbitMQClient = async () => {
  const maxRetries = 5
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await rabbitMQService.connect()
      logInfo('[user-service] RabbitMQ client initialized. now listening...')
      return
    } catch (e) {
      if (attempt < maxRetries) {
        const delay = 2000 * attempt
        logWarn(`[user-service] RabbitMQ connection attempt ${attempt}/${maxRetries} failed, retrying in ${delay}ms...`)
        await new Promise(r => setTimeout(r, delay))
      } else {
        logError(`[user-service] Failed to initialize RabbitMQ client after all retries: ${e}`)
      }
    }
  }
}

// Start the server
startServer()

const gracefulShutdown = async (signal: string) => {
  logInfo(`[user-service] ${signal} received. Starting graceful shutdown...`)
  try {
    // 1. Stop accepting new HTTP connections
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      logInfo('[user-service] HTTP server closed')
    }
    // 2. Close RabbitMQ
    await rabbitMQService.disconnect()
    // 3. Close database
    const { AppDataSource } = await import('./database/connection')
    if (AppDataSource.isInitialized) {
      await AppDataSource.destroy()
      logInfo('[user-service] Database connection closed')
    }
    logInfo('[user-service] Graceful shutdown complete')
    process.exit(0)
  } catch (err) {
    logError('[user-service] Error during graceful shutdown:', err)
    process.exit(1)
  }
}

const unexpectedErrorHandler = (error: unknown) => {
  logError('[user-service]: Uncaught Exception', error)
  gracefulShutdown('UNCAUGHT_EXCEPTION').catch(() => process.exit(1))
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))
process.on('uncaughtException', unexpectedErrorHandler)
process.on('unhandledRejection', unexpectedErrorHandler)