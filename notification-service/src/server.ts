import express, { Express } from 'express'
import cors from 'cors'
import helmet from 'helmet'
import { Server } from 'http'
import { errorMiddleware, errorHandler } from './middleware'
import config from './config/config'
import { rabbitMQService } from './services/RabbitMQService'
import { connectDB } from './database'
import notificationRouter from './routes/notificationRoutes'

// Validate required environment variables on startup
const validateEnv = () => {
  const required = ['PORT', 'MESSAGE_BROKER_URL', 'NOTIFICATIONS_QUEUE', 'MONGO_URI', 'JWT_SECRET']
  const missing = required.filter(key => !process.env[key])
  
  if (missing.length > 0) {
    console.error(`[notification-service] FATAL: Missing required environment variables: ${missing.join(', ')}`)
    process.exit(1)
  }
  
  // Warn if email credentials are missing (optional but recommended)
  if (!process.env.SMTP_HOST && !process.env.SENDINBLUE_APIKEY) {
    console.warn('[notification-service] WARNING: No email credentials configured (SMTP or SendinBlue)')
  }
}

validateEnv()

const app: Express = express()
let server: Server

// CORS must be applied before helmet to ensure preflight requests are handled properly
const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map(o => o.trim())
  : ['http://localhost:5173', 'http://localhost:85', 'http://localhost:8080']

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps, curl, Postman)
    if (!origin) return callback(null, true)
    
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true)
    } else {
      console.warn(`[notification-service] CORS blocked origin: ${origin}`)
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

// Basic HTTP hardening (applied after CORS)
app.use(helmet())

// Limit body size
app.use(express.json({ limit: '100kb' }))
app.use(express.urlencoded({ extended: true, parameterLimit: 1000 }))

// Health check endpoint for Docker and monitoring
app.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }))

// Mount notification routes (use plural `/notifications` prefix for consistency)
app.use('/notifications', notificationRouter)

app.use(errorMiddleware)
app.use(errorHandler)

const start = async () => {
  // Connect to MongoDB
  await connectDB()

  server = app.listen(config.PORT, () => {
    console.log(`[notification-service] Server is running on port ${config.PORT}`)
  })

  // Initialize RabbitMQ client for message queue consumption
  await initializeRabbitMQClient()
}

const initializeRabbitMQClient = async () => {
  try {
    await rabbitMQService.connect()
    console.log('[notification-service] RabbitMQ client initialized. now listening...')
  } catch (e) {
    console.error(`[notification-service] Failed to initialize RabbitMQ client: ${e}`)
  }
}

start().catch(err => {
  console.error('[notification-service] Failed to start:', err)
  process.exit(1)
})

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
  console.error('[notification-service]: Uncaught Exception', error)
  exitHandler()
}

process.on('uncaughtException', unexpectedErrorHandler)
process.on('unhandledRejection', unexpectedErrorHandler)