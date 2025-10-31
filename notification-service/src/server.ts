import express, { Express } from 'express'
import { Server } from 'http'
import { errorMiddleware, errorHandler } from './middleware'
import config from './config/config'
import { rabbitMQService } from './services/RabbitMQService'

const app: Express = express()
let server: Server
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(errorMiddleware)
app.use(errorHandler)

server = app.listen(config.PORT, () => {
  console.log(`Notification Service is running on port ${config.PORT}`)
})

const initializeRabbitMQClient = async () => {
  try {
    await rabbitMQService.connect()
    console.log('RabbitMQ client initialized. now listening...')
  } catch (e) {
    console.error(`Failed to initialize RabbitMQ client: ${e}`)
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
  console.error(error)
  exitHandler()
}

process.on('uncaughtException', unexpectedErrorHandler)
process.on('unhandledRejection', unexpectedErrorHandler)