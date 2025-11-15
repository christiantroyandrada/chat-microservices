import { Server } from 'http'
import { Socket, Server as SocketIOServer } from 'socket.io'
import jwt from 'jsonwebtoken'
import type { TokenPayload } from './types'
import app from './app'
import { Message, connectDB, AppDataSource } from './database'
import { MessageStatus } from './database/models/MessageModel'
import config from './config/config'
import { rabbitMQService } from './services/RabbitMQService'
import { handleMessageReceived } from './utils'

// Validate required environment variables on startup
const validateEnv = () => {
  const required = ['JWT_SECRET', 'DATABASE_URL', 'PORT', 'MESSAGE_BROKER_URL']
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

    // Maximum message size (1MB) to prevent memory exhaustion
    maxHttpBufferSize: 1e6,

    // Make CORS explicit - use environment variables for allowed origins
    cors: {
      origin: process.env.CORS_ORIGINS 
        ? process.env.CORS_ORIGINS.split(',').map(o => o.trim())
        : ['http://localhost:5173', 'http://localhost:85', 'http://localhost:8080'], // Default for local dev (include frontend)
      credentials: true,
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization']
    },

    // Let Socket.IO pick websocket then fallback to polling
    transports: ['websocket', 'polling'] // optional; default includes both
  })

  // JWT authentication middleware for Socket.IO
  io.use((socket, next) => {
    try {
      // First, prefer token passed via auth payload (used by non-browser clients)
      let token: string | undefined = socket.handshake.auth?.token;

      // If no token in auth payload, try to read httpOnly cookie from handshake headers
      // (browser clients will send the JWT in a cookie)
      if (!token) {
        const cookieHeader = socket.handshake.headers?.cookie as string | undefined;
        if (cookieHeader) {
          // simple cookie parse to extract 'jwt' value
          const match = cookieHeader.split(';').map(s => s.trim()).find(s => s.startsWith('jwt='));
          if (match) {
            token = match.substring('jwt='.length);
          }
        }
      }

      if (!token) {
        return next(new Error('Authentication required'));
      }

      // Verify JWT token
  const decoded = jwt.verify(token, config.JWT_SECRET as string) as TokenPayload;
      
      // Attach user to socket
      socket.data.user = {
        id: decoded.id,
        email: decoded.email,
        name: decoded.name
      };
      
      next();
    } catch (err) {
      next(new Error('Invalid token'));
    }
  });


  io.on('connection', (socket: Socket) => {
    console.log('[chat-service] New client connected: ', socket.id)

    // Use authenticated user ID from JWT (already verified by middleware)
    const userId = socket.data.user?.id;
    if (userId) {
      socket.join(userId);
      console.log('[chat-service] User joined room:', userId, 'socket:', socket.id);
    } else {
      console.warn('[chat-service] No userId found for socket:', socket.id);
    }

    socket.on('disconnect', () => {
      console.log('[chat-service] Client disconnected: ', socket.id)
    })

    socket.on('receiveMessage', (message) => {
      io.emit('receiveMessage', message)
    })

    socket.on('sendMessage', async (data, ack?: (res: { ok: boolean; id?: string; error?: string }) => void) => {
      try {
        const { senderId, receiverId, message, _id } = data
        
        // Validate: authenticated user can only send as themselves
        if (senderId !== userId) {
          ack?.({ ok: false, error: 'Unauthorized: cannot send as another user' });
          return;
        }

        // Validate message content
        if (!message || typeof message !== 'string') {
          ack?.({ ok: false, error: 'Invalid message content' });
          return;
        }

        const trimmedMessage = message.trim();
        if (trimmedMessage.length === 0 || trimmedMessage.length > 5000) {
          ack?.({ ok: false, error: 'Message must be between 1 and 5000 characters' });
          return;
        }

        // Validate receiverId
        if (!receiverId || senderId === receiverId) {
          ack?.({ ok: false, error: 'Invalid receiver' });
          return;
        }

        // If message has _id, it was already saved via HTTP API - just retrieve it for broadcasting
        // Otherwise, validate envelope and save new encrypted message (no plaintext allowed)
        let msg;
        const messageRepo = AppDataSource.getRepository(Message);
        if (_id) {
          // Message already exists - just retrieve it for broadcasting
          msg = await messageRepo.findOne({ where: { id: _id } });
          if (!msg) {
            ack?.({ ok: false, error: 'Message not found' });
            return;
          }
          // If the stored message is not marked encrypted, reject under new policy
          if (!msg.isEncrypted) {
            ack?.({ ok: false, error: 'Server policy: plaintext messages are not allowed' });
            return;
          }
        } else {
          // Save new message (fallback for WebSocket-only clients)
          // Enforce encrypted envelope JSON
          let parsedEnvelope: unknown = null
          try {
            parsedEnvelope = JSON.parse(trimmedMessage)
          } catch (e) {
            ack?.({ ok: false, error: 'Messages must be end-to-end encrypted (invalid envelope)' });
            return;
          }

          const envelopeCandidate = parsedEnvelope as { __encrypted?: boolean; body?: unknown } | null
          if (!envelopeCandidate || envelopeCandidate.__encrypted !== true || typeof envelopeCandidate.body !== 'string') {
            ack?.({ ok: false, error: 'Messages must be end-to-end encrypted' });
            return;
          }

          msg = await messageRepo.save({
            senderId,
            receiverId,
            message: trimmedMessage,
            isEncrypted: true,
            status: MessageStatus.NotDelivered,
          })

          // Notify receiver (no plaintext leak)
          const { email, name } = socket.data.user || { email: undefined, name: undefined }
          try {
            await handleMessageReceived(name || '', email || '', receiverId, '[Encrypted message]', true, trimmedMessage)
          } catch (err) {
            // Notification failures should not block message delivery
            console.warn('[chat-service] notifyReceiver failed:', err)
          }
        }
        
        // Format message for frontend consumption (normalize field names)
        // Frontend expects: _id, senderId, senderUsername, receiverId, content (not message), timestamp
        const { email, name } = socket.data.user || { email: undefined, name: undefined }
        const formattedMsg = {
          _id: msg.id,
          id: msg.id,
          senderId: msg.senderId,
          senderUsername: name || undefined,
          senderName: name || undefined,
          receiverId: msg.receiverId,
          content: msg.message, // Frontend uses 'content', backend DB uses 'message'
          message: msg.message, // Include both for compatibility
          timestamp: msg.createdAt,
          createdAt: msg.createdAt,
          updatedAt: msg.updatedAt,
          read: false,
          isRead: false
        }
        
        console.log('[chat-service] Broadcasting message to receiver:', receiverId, 'content length:', msg.message?.length)
        
        // Broadcast to receiver
        io.to(receiverId).emit('receiveMessage', formattedMsg)
        ack?.({ ok: true, id: msg.id })
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