import express, { Express } from 'express'
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
  console.error(error)
  exitHandler()
}

process.on('uncaughtException', unexpectedErrorHandler)
process.on('unhandledRejection', unexpectedErrorHandler)