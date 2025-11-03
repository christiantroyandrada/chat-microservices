import express, { Express } from 'express'
import helmet from 'helmet'
import { Server } from 'http'
import { errorMiddleware, errorHandler } from './middleware'
import config from './config/config'
import { rabbitMQService } from './services/RabbitMQService'

const app: Express = express()
let server: Server

// Basic HTTP hardening
app.use(helmet())

// limit body size
app.use(express.json({ limit: '100kb' }))
app.use(express.urlencoded({ extended: true }))
// Health check endpoint for Docker and monitoring
app.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }))
app.use(errorMiddleware)
app.use(errorHandler)

server = app.listen(config.PORT, () => {
  console.log(`Notification Service is running on port ${config.PORT}`)
})

const initializeRabbitMQClient = async () => {
  try {
    await rabbitMQService.connect()
    console.log('[notification-service] RabbitMQ client initialized. now listening...')
  } catch (e) {
    console.error(`[notification-service] Failed to initialize RabbitMQ client: ${e}`)
  }
}

initializeRabbitMQClient()

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