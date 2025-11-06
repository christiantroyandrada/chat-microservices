import { Server } from 'http'
import { Socket, Server as SocketIOServer } from 'socket.io'
import app from './app'
import { Message, connectDB } from './database'
import config from './config/config'
import { rabbitMQService } from './services/RabbitMQService'

// Validate required environment variables on startup
const validateEnv = () => {
  const required = ['JWT_SECRET', 'MONGO_URI', 'PORT', 'MESSAGE_BROKER_URL']
  const missing = required.filter(key => !process.env[key])
  
  if (missing.length > 0) {
    console.error(`[chat-service] FATAL: Missing required environment variables: ${missing.join(', ')}`)
    process.exit(1)
  }
  
  // Warn about default/weak secrets
  if (process.env.JWT_SECRET === '{{YOUR_SECRET_KEY}}' || process.env.JWT_SECRET === 'CHANGEME') {
    console.warn('[chat-service] WARNING: Using default JWT_SECRET. Change this in production!')
  }
}

validateEnv()

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

  // after `server = app.listen(...)`
  const io = new SocketIOServer(server, {
    // MUST match the NGINX location below
    path: '/chat/socket.io',

    // Heartbeats: default is fine, but make them explicit
    pingInterval: 25000,   // server sends ping every 25s
    pingTimeout: 60000,    // drop if no pong within 60s

    // Helpful compression limit (optional)
    perMessageDeflate: { threshold: 1024 },

    // Make CORS explicit - use environment variables for allowed origins
    cors: {
      origin: process.env.CORS_ORIGINS 
        ? process.env.CORS_ORIGINS.split(',').map(o => o.trim())
        : ['http://localhost:85', 'http://localhost:8080'], // Default for local dev
      credentials: true,
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization']
    },

    // Let Socket.IO pick websocket then fallback to polling
    transports: ['websocket', 'polling'] // optional; default includes both
  })


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

    socket.on('sendMessage', async (data, ack?: (res: { ok: boolean; id?: string; error?: string }) => void) => {
      try {
        const { senderId, receiverId, message } = data
        const msg = new Message({ senderId, receiverId, message })
        await msg.save()
        io.to(receiverId).emit('receiveMessage', msg)
        ack?.({ ok: true, id: String(msg._id) })
      } catch (err) {
        console.error('[chat-service] socket sendMessage error:', err)
        ack?.({ ok: false, error: 'Failed to send message' })
        // Prefer a namespaced error event vs. 'error' (which Socket.IO also uses internally)
        socket.emit('server:error', { message: 'Failed to send message' })
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