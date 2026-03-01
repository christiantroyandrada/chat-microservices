import 'reflect-metadata'
import express, { Express } from 'express'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import cookieParser from 'cookie-parser'
import chatServiceRouter from './routes/messageRoutes'
import { errorMiddleware, errorHandler } from './middleware'
import { logError } from './utils/logger'
import { rabbitMQService } from './services/RabbitMQService'
import { AppDataSource } from './database/connection'

const app: Express = express()

app.set('trust proxy', 1)
// CORS for chat REST endpoints. Socket.IO has its own CORS settings in server.ts.
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
      console.warn(`[chat-service] CORS blocked origin: ${origin}`)
      callback(null, false)
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  preflightContinue: false,
  optionsSuccessStatus: 204
}))

app.use(helmet())

app.get('/health', async (req, res) => {
	const checks: Record<string, boolean> = {
		database: false,
		rabbitmq: false
	}
	try {
		checks.database = AppDataSource.isInitialized
		checks.rabbitmq = rabbitMQService.isHealthy()
		const healthy = checks.database && checks.rabbitmq
		return res.status(healthy ? 200 : 503).json({ status: healthy ? 'ok' : 'degraded', service: 'chat-service', checks })
	} catch (err) {
		logError('[chat-service] Health check error:', err)
		return res.status(503).json({ status: 'error', service: 'chat-service', checks, error: String(err) })
	}
})

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: 'Too many requests from this IP, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
})
app.use(globalLimiter)
app.use(express.json({ limit: '100kb' }))
app.use(express.urlencoded({ extended: true, parameterLimit: 1000 }))
app.use(cookieParser()) // Parse cookies to read JWT from httpOnly cookies

app.use(chatServiceRouter)
app.use(errorMiddleware)
app.use(errorHandler)

export default app