import express, { Express } from 'express'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import mongoSanitize from 'express-mongo-sanitize'
import cookieParser from 'cookie-parser'
import mongoose from 'mongoose'
import { Server } from 'http'
import userServiceRouter from './routes/userServiceRouter'
import { errorMiddleware, errorHandler } from './middleware'
import { connectDB } from './database'
import config from './config/config'
import { rabbitMQService } from './services/RabbitMQService'

// Validate required environment variables on startup
const validateEnv = () => {
  const required = ['JWT_SECRET', 'MONGO_URI', 'PORT', 'MESSAGE_BROKER_URL']
  const missing = required.filter(key => !process.env[key])
  
  if (missing.length > 0) {
    console.error(`[user-service] FATAL: Missing required environment variables: ${missing.join(', ')}`)
    process.exit(1)
  }
  
  // Warn about default/weak secrets
  if (process.env.JWT_SECRET === '{{YOUR_SECRET_KEY}}' || process.env.JWT_SECRET === 'CHANGEME') {
    console.warn('[user-service] WARNING: Using default JWT_SECRET. Change this in production!')
  }
}

validateEnv()

const app: Express = express()
let server: Server

app.set('trust proxy', 1)
// Configure CORS for the user service. Can be overridden with CORS_ORIGINS env var (comma-separated).
const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map(o => o.trim())
  : ['http://localhost:5173', 'http://localhost:85', 'http://localhost:8080']
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
    const state = mongoose.connection.readyState
    if (state !== 1) {
      return res.status(503).json({ status: 'error', dbState: state })
    }
    if (mongoose.connection.db) {
      await mongoose.connection.db.admin().ping()
    }
    return res.status(200).json({ status: 'ok', db: 'ok' })
  } catch (err) {
    return res.status(503).json({ status: 'error', error: String(err) })
  }
})

app.use(helmet())

app.use(cookieParser())

// NOTE: MongoDB sanitization disabled due to express-mongo-sanitize incompatibility with Express 5.x
// Input validation middleware provides primary defense against injection attacks

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
  console.log(`User Service is running on port ${config.PORT}`)
})

const initRabbitMQClient = async () => {
  try {
    await rabbitMQService.connect()
    console.log('[user-service] RabbitMQ client initialized. now listening...')
  } catch (e) {
    console.error(`[user-service] Failed to initialize RabbitMQ client: ${e}`)
  }
}
initRabbitMQClient()

const exitHandler = () => {
  if (server) {
    server.close(() => {
      console.info('server closed')
      process.exit(1)
    })
  } else {
    process.exit(1)
  }
}

const unexpectedErrorHandler = (error: unknown) => {
  console.error('[user-service]: Uncaught Exception', error)
  exitHandler()
}

process.on('uncaughtException', unexpectedErrorHandler)
process.on('unhandledRejection', unexpectedErrorHandler)