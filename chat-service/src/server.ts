import { Server } from 'http'
import { Socket, Server as SocketIOServer } from 'socket.io'
import app from './app'
import { Message, connectDB } from './database'
import config from './config/config'

let server: Server
connectDB()

server = app.listen(config.PORT, () => {
  console.log(`[chat-service]: Server is running at port ${config.PORT}`)
})

const io = new SocketIOServer(server)
io.on('connection', (socket: Socket) => {
  console.log('[chat-service] New client connected: ', socket.id)
  socket.on('disconnect', () => {
    console.log('[chat-service] Client disconnected: ', socket.id)
  })
 
  socket.on('receiveMessage', (message) => {
    io.emit('receiveMessage', message)
  })

  socket.on('sendMessage', async (data) => {
    const { senderId, receiverId, message } = data
    const msg = new Message({
      senderId,
      receiverId,
      message,
    })
    await msg.save()
    io.to(receiverId).emit('receiveMessage', msg)
  })
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