import { Server } from 'node:http'
import { Socket, Server as SocketIOServer } from 'socket.io'
import jwt from 'jsonwebtoken'
import config from '../config/config'
import type { TokenPayload } from '../types'
import { registerSocketHandlers } from './socketHandler'
import { logDebug, logError } from '../utils/logger'

/**
 * Create and configure the Socket.IO server with JWT authentication
 * and register all event handlers.
 *
 * Extracted from server.ts for single-responsibility compliance.
 */
export function createSocketServer(httpServer: Server): SocketIOServer {
  const io = new SocketIOServer(httpServer, {
    path: '/chat/socket.io',
    pingInterval: 25000,
    pingTimeout: 60000,
    perMessageDeflate: { threshold: 1024 },
    maxHttpBufferSize: 1e6,
    cors: {
      origin: (origin, callback) => {
        const allowedOrigins = process.env.CORS_ORIGINS
          ? process.env.CORS_ORIGINS.split(',').map(o => o.trim())
          : ['http://localhost:5173', 'http://localhost:3000', 'http://localhost:80', 'http://localhost:8080']

        if (!origin) return callback(null, true)

        if (allowedOrigins.includes(origin)) {
          callback(null, origin)
        } else {
          console.warn(`[chat-service] Socket.IO CORS blocked origin: ${origin}`)
          callback(null, false)
        }
      },
      credentials: true,
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    },
    transports: ['websocket', 'polling'],
  })

  // JWT authentication middleware
  io.use((socket, next) => {
    try {
      let token: string | undefined = socket.handshake.auth?.token

      if (!token) {
        const cookieHeader = socket.handshake.headers?.cookie as string | undefined
        if (cookieHeader) {
          const match = cookieHeader.split(';').map(s => s.trim()).find(s => s.startsWith('jwt='))
          if (match) {
            token = match.substring('jwt='.length)
          }
        }
      }

      if (!token) {
        return next(new Error('Authentication required'))
      }

      const decoded = jwt.verify(token, config.JWT_SECRET as string) as TokenPayload
      socket.data.user = {
        id: decoded.id,
        email: decoded.email,
        username: decoded.username,
      }

      next()
    } catch (err) {
      logError('[chat-service] Socket.IO jwt auth middleware error:', err)
      next(new Error('Invalid token'))
    }
  })

  // Register connection handler
  io.on('connection', (socket: Socket) => {
    logDebug('[chat-service] New client connected:', socket.id)
    registerSocketHandlers(io, socket)
  })

  return io
}
