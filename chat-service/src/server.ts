import { Server } from 'http'
import { Socket, Server as SocketIOServer } from 'socket.io'
import app from './app'
import { Message, connectDB } from './database'
import config from './config/config'
import { rabbitMQService } from './services/RabbitMQService'

let server: Server

const start = async () => {
  await connectDB()

  // ensure the RPC/notification client is connected before handling messages
  try {
    await rabbitMQService.connect()
    console.log('[chat-service] RabbitMQ client connected')
  } catch (err) {
    console.error('[chat-service] Failed to connect RabbitMQ client:', err)
  }

  server = app.listen(config.PORT, () => {
    console.log(`[chat-service]: Server is running at port ${config.PORT}`)
  })

  const io = new SocketIOServer(server)

  io.on('connection', (socket: Socket) => {
    console.log('[chat-service] New client connected: ', socket.id)

    // clients should emit an 'identify' event with their userId after connecting
    socket.on('identify', (userId: string) => {
      if (userId) {
        socket.join(userId)
      }
    })

    socket.on('disconnect', () => {
      console.log('[chat-service] Client disconnected: ', socket.id)
    })

    socket.on('receiveMessage', (message) => {
      io.emit('receiveMessage', message)
    })

    socket.on('sendMessage', async (data) => {
      try {
        const { senderId, receiverId, message } = data
        const msg = new Message({
          senderId,
          receiverId,
          message,
        })
        await msg.save()
        io.to(receiverId).emit('receiveMessage', msg)
      } catch (err) {
        console.error('[chat-service] socket sendMessage error:', err)
        socket.emit('error', { message: 'Failed to send message' })
      }
    })
  })
}

start().catch(err => {
  console.error('[chat-service] Failed to start:', err)
  process.exit(1)
})

const exitHandler = () => {
  if (server) {
    server.close(() => {
      console.log('[chat-service]: Server closed')
      process.exit(1)
    })
  } else {
    process.exit(1)
  }
}

const unexpectedErrorHandler = (error: unknown) => {
  console.error('[chat-service]: Uncaught Exception', error)
  exitHandler()
}

process.on('uncaughtException', unexpectedErrorHandler)
process.on('unhandledRejection', unexpectedErrorHandler)