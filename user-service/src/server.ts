import express, { Express } from 'express'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import mongoose from 'mongoose'
import { Server } from 'http'
import userServiceRouter from './routes/userServiceRouter'
import { errorMiddleware, errorHandler } from './middleware'
import { connectDB } from './database'
import config from './config/config'
import { rabbitMQService } from './services/RabbitMQService'

const app: Express = express()
let server: Server

// Basic HTTP hardening
app.use(helmet())

// Body size limit to mitigate large-payload DoS
app.use(express.json({ limit: '100kb' }))
app.use(express.urlencoded({ extended: true, parameterLimit: 1000 }))

// Rate limiter - apply to auth endpoints via router-level middleware (see routes)
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 })
// Health check endpoint for Docker and monitoring (includes DB readiness)
app.get('/health', async (_req, res) => {
  try {
    const state = mongoose.connection.readyState
    // 1 = connected
    if (state !== 1) {
      return res.status(503).json({ status: 'error', dbState: state })
    }
    // perform a lightweight ping to verify DB responsiveness
    if (mongoose.connection.db) {
      await mongoose.connection.db.admin().ping()
    }
    return res.status(200).json({ status: 'ok', db: 'ok' })
  } catch (err) {
    return res.status(503).json({ status: 'error', error: String(err) })
  }
})
// apply authLimiter to registration/login routes inside the router file
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