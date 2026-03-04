import 'reflect-metadata'
import express, { Express } from 'express'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import cookieParser from 'cookie-parser'
import swaggerUi from 'swagger-ui-express'
import chatServiceRouter from './routes/messageRoutes'
import { errorMiddleware, errorHandler } from './middleware'
import { requestLogger } from './middleware/requestLogger'
import { logError } from './utils/logger'
import { getMetrics, getContentType } from './utils/metrics'
import { rabbitMQService } from './services/RabbitMQService'
import { AppDataSource } from './database/connection'
import openapiSpec from './openapi'

// ── Redis health provider ─────────────────────────────────────────────────────
// Set by server.ts after Redis is initialised (if REDIS_URL is configured).
// null means Redis is not configured — omitted from health checks (not a failure).
let _getRedisHealth: (() => boolean | null) | null = null

export function setRedisHealthProvider(fn: () => boolean | null): void {
  _getRedisHealth = fn
}
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

// ── Security (Factor XV — explicit CSP, OWASP-compliant) ────────────────────
const isProduction = process.env.NODE_ENV === 'production'
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  isProduction ? ["'self'"] : ["'self'", "'unsafe-inline'"],
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
  // HSTS is handled at the nginx TLS-termination layer — avoid duplicate headers
  strictTransportSecurity: false,
}))

// ── API contract (Factor XIII — API First) ──────────────────────────────────
app.get('/api-docs.json', (_req, res) => res.json(openapiSpec))
if (!isProduction) {
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openapiSpec, { explorer: true }))
}

// ── Observability ────────────────────────────────────────────────────────────
// Request ID + HTTP access log + Prometheus counter/histogram
app.use(requestLogger)

// Prometheus metrics — only reachable within the Docker network (nginx blocks
// public access to /chat/metrics). No auth needed inside the private network.
// Not rate-limited intentionally: Docker/Prometheus scrape this on schedule;
// rate-limiting would break orchestration.
app.get('/metrics', async (_req, res) => {
  try {
    res.set('Content-Type', getContentType())
    res.end(await getMetrics())
  } catch (err) {
    logError('[chat-service] Failed to collect metrics:', err)
    res.status(500).end()
  }
})

app.get('/health', async (req, res) => {
	const checks: Record<string, boolean | null> = {
		database: false,
		rabbitmq: false
	}
	try {
		checks.database = AppDataSource.isInitialized
		checks.rabbitmq = rabbitMQService.isHealthy()
		// redis: null = not configured (not a failure); false = configured but unhealthy
		if (_getRedisHealth !== null) {
			checks.redis = _getRedisHealth()
		}
		const healthy = (checks.database ?? false) && (checks.rabbitmq ?? false) && (checks.redis ?? true)
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