import 'reflect-metadata'
import express, { Express } from 'express'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import cookieParser from 'cookie-parser'
import { Server } from 'node:http'
import userServiceRouter from './routes/userServiceRouter'
import { errorMiddleware, errorHandler } from './middleware'
import { connectDB } from './database'
import config from './config/config'
import { rabbitMQService } from './services/RabbitMQService'
import { logInfo, logWarn, logError } from './utils/logger'

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
  : ['http://localhost:5173', 'http://localhost:80', 'http://localhost:8080']
app.use(cors({
  origin: allowedOrigins,
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  preflightContinue: false,
  optionsSuccessStatus: 204
}))

app.get('/health', async (_req, res) => {
  try {
    // Simple health check - just return OK
    // Database connection is verified on startup
    return res.status(200).json({ status: 'ok', service: 'user-service' })
  } catch (err) {
    return res.status(503).json({ status: 'error', error: String(err) })
  }
})

app.use(helmet())

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

connectDB()

server = app.listen(config.PORT, () => {
  logInfo(`User Service is running on port ${config.PORT}`)
})

const initRabbitMQClient = async () => {
  try {
    await rabbitMQService.connect()
    logInfo('[user-service] RabbitMQ client initialized. now listening...')
  } catch (e) {
    logError(`[user-service] Failed to initialize RabbitMQ client: ${e}`)
  }
}
initRabbitMQClient()

const exitHandler = () => {
  if (server) {
    server.close(() => {
      logInfo('server closed')
      process.exit(1)
    })
  } else {
    process.exit(1)
  }
}

const unexpectedErrorHandler = (error: unknown) => {
  logError('[user-service]: Uncaught Exception', error)
  exitHandler()
}

process.on('uncaughtException', unexpectedErrorHandler)
process.on('unhandledRejection', unexpectedErrorHandler)