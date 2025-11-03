import express, { Express } from 'express'
import mongoose from 'mongoose'
import { Server } from 'http'
import userServiceRouter from './routes/userServiceRouter'
import { errorMiddleware, errorHandler } from './middleware'
import { connectDB } from './database'
import config from './config/config'
import { rabbitMQService } from './services/RabbitMQService'

const app: Express = express()
let server: Server
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
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