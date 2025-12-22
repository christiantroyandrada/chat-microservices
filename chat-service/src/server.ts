import { Server } from 'node:http'
import { Socket, Server as SocketIOServer } from 'socket.io'
import jwt from 'jsonwebtoken'
import type { TokenPayload } from './types'
import app from './app'
import { Message, connectDB, AppDataSource, runMigrations } from './database'
import { MessageStatus } from './database/models/MessageModel'
import config from './config/config'
import { rabbitMQService } from './services/RabbitMQService'
import { handleMessageReceived, UserStatusStore } from './utils'

import { logDebug, logInfo, logWarn, logError } from './utils/logger'

// Validate required environment variables on startup
const validateEnv = () => {
  const required = ['JWT_SECRET', 'DATABASE_URL', 'PORT', 'MESSAGE_BROKER_URL']
  const missing = required.filter(key => !process.env[key])
  
  if (missing.length > 0) {
    logError(`[chat-service] FATAL: Missing required environment variables: ${missing.join(', ')}`)
    process.exit(1)
  }
  
  // Warn about default/weak secrets
  if (process.env.JWT_SECRET === '{{YOUR_SECRET_KEY}}' || process.env.JWT_SECRET === 'CHANGEME') {
    logWarn('[chat-service] WARNING: Using default JWT_SECRET. Change this in production!')
  }
}

validateEnv()

let server: Server

const start = async () => {
  // Connect to database
  await connectDB()
  
  // Run any pending migrations (idempotent - skips already run migrations)
  await runMigrations()

  // ensure the RPC/notification client is connected before handling messages
  try {
    await rabbitMQService.connect()
    logInfo('[chat-service] RabbitMQ client connected')
  } catch (err) {
    logError('[chat-service] Failed to connect RabbitMQ client:', err)
  }

  server = app.listen(config.PORT, () => {
    logInfo(`[chat-service]: Server is running at port ${config.PORT}`)
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
      origin: (origin, callback) => {
        const allowedOrigins = process.env.CORS_ORIGINS 
          ? process.env.CORS_ORIGINS.split(',').map(o => o.trim())
          : ['http://localhost:5173', 'http://localhost:3000', 'http://localhost:80', 'http://localhost:8080'];
        
        // Allow requests with no origin (like mobile apps, curl, Postman)
        if (!origin) return callback(null, true);
        
        if (allowedOrigins.includes(origin)) {
          callback(null, origin);
        } else {
          console.warn(`[chat-service] Socket.IO CORS blocked origin: ${origin}`);
          callback(null, false);
        }
      },
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
        username: decoded.username
      };
      
      next();
    } catch (err) {
      logError('[chat-service] Socket.IO jwt auth middleware error:', err);
      next(new Error('Invalid token'));
    }
  });


  // Track active user connections (userId -> Set of socket IDs)
  const activeUsers = new Map<string, Set<string>>();
  // Mirror presence into an in-process status store so other modules can
  // cheaply check whether a user is considered online without RPC.
  const userStatusStore = UserStatusStore.getInstance()
  
  // Track typing status with timeout (userId -> timeout reference)
  const typingTimeouts = new Map<string, NodeJS.Timeout>();

  io.on('connection', (socket: Socket) => {
    logDebug('[chat-service] New client connected:', socket.id)

    // Use authenticated user ID from JWT (already verified by middleware)
    const userId = socket.data.user?.id;
      if (userId) {
  socket.join(userId);
  logDebug('[chat-service] User joined room:', userId, 'socket:', socket.id);

      // Track this user as online
      if (!activeUsers.has(userId)) {
        activeUsers.set(userId, new Set());
      }
      activeUsers.get(userId)!.add(socket.id);

      // Also update the in-process status store (used to decide whether to
      // publish notification events to the messaging queue).
      userStatusStore.setUserOnline(userId)

      // If this is the user's first connection, broadcast online status to all clients
      if (activeUsers.get(userId)!.size === 1) {
        logInfo('[chat-service] User came online:', userId);
        io.emit('presence', {
          userId,
          online: true
        });
      }

      // Send current online status of all other users to the newly connected client
      // This ensures they get the initial presence state
      activeUsers.forEach((sockets, onlineUserId) => {
        if (onlineUserId !== userId && sockets.size > 0) {
          socket.emit('presence', {
            userId: onlineUserId,
            online: true
          });
        }
      });
      logDebug('[chat-service] Sent initial presence state to:', userId, 'for', activeUsers.size - 1, 'other users');
    } else {
      logWarn('[chat-service] No userId found for socket:', socket.id);
    }

    socket.on('disconnect', () => {
      logDebug('[chat-service] Client disconnected:', socket.id)

      // Clear typing timeout if user had one active
      if (userId && typingTimeouts.has(userId)) {
        clearTimeout(typingTimeouts.get(userId));
        typingTimeouts.delete(userId);
      }

      // Update presence tracking
      if (userId && activeUsers.has(userId)) {
        const userSockets = activeUsers.get(userId)!;
        userSockets.delete(socket.id);

        // If user has no more active connections, mark as offline
        if (userSockets.size === 0) {
          activeUsers.delete(userId);
          // update in-process store
          userStatusStore.setUserOffline(userId)
          const lastSeen = new Date().toISOString();
          logInfo('[chat-service] User went offline:', userId, 'lastSeen:', lastSeen);
          io.emit('presence', {
            userId,
            online: false,
            lastSeen
          });
        }
      }
    })

    socket.on('receiveMessage', (message) => {
      io.emit('receiveMessage', message)
    })

    // Handle typing indicator with auto-timeout
    socket.on('typing', (data: { receiverId: string; isTyping: boolean }) => {
      if (!userId) return;
      
  const { receiverId, isTyping } = data;
  logDebug('[chat-service] Typing event:', { userId, receiverId, isTyping });
      
      // Clear existing timeout for this user
      if (typingTimeouts.has(userId)) {
        clearTimeout(typingTimeouts.get(userId));
        typingTimeouts.delete(userId);
      }
      
      if (isTyping) {
        // Broadcast typing status to the receiver
        io.to(receiverId).emit('typing', {
          userId,
          isTyping: true
        });
        
        // Set auto-timeout: if no activity for 3 seconds, auto-stop typing
        const timeout = setTimeout(() => {
          logDebug('[chat-service] Typing timeout for user:', userId);
          io.to(receiverId).emit('typing', {
            userId,
            isTyping: false
          });
          typingTimeouts.delete(userId);
        }, 3000); // 3 seconds timeout
        
        typingTimeouts.set(userId, timeout);
      } else {
        // User stopped typing - broadcast immediately
        io.to(receiverId).emit('typing', {
          userId,
          isTyping: false
        });
      }
    });

    // Helper: validate and normalize message content; returns trimmed string or null (and sends ack)
    const validateMessage = (message: unknown, ack?: (res: { ok: boolean; id?: string; error?: string }) => void) => {
      if (!message || typeof message !== 'string') {
        ack?.({ ok: false, error: 'Invalid message content' })
        return null
      }
      const trimmed = message.trim()
      if (trimmed.length === 0 || trimmed.length > 5000) {
        ack?.({ ok: false, error: 'Message must be between 1 and 5000 characters' })
        return null
      }
      return trimmed
    }

    // Helper: retrieve an existing message by _id or validate/save a new encrypted envelope
    const retrieveOrSaveMessage = async (params: { _id?: string; trimmed: string; senderId: string; receiverId: string; messageRepo: any; username?: string; socket: Socket; ack?: (res: { ok: boolean; id?: string; error?: string }) => void; }) => {
      const { _id, trimmed, senderId, receiverId, messageRepo, username, socket, ack } = params

      if (_id) {
        const existing = await messageRepo.findOne({ where: { id: _id } })
        if (!existing) {
          ack?.({ ok: false, error: 'Message not found' })
          return null
        }
        if (!existing.isEncrypted) {
          ack?.({ ok: false, error: 'Server policy: plaintext messages are not allowed' })
          return null
        }
        return existing
      }

      // parse encrypted envelope
      let parsed: unknown = null
      try {
        parsed = JSON.parse(trimmed)
      } catch (e) {
        logWarn('[chat-service] Failed to parse encrypted envelope (ws):', e)
        ack?.({ ok: false, error: 'Messages must be end-to-end encrypted (invalid envelope)' })
        return null
      }

      const env = parsed as { __encrypted?: boolean; body?: unknown } | null
      if (env?.__encrypted !== true || typeof env?.body !== 'string') {
        ack?.({ ok: false, error: 'Messages must be end-to-end encrypted' })
        return null
      }

      const saved = await messageRepo.save({
        senderId,
        receiverId,
        message: trimmed,
        isEncrypted: true,
        status: MessageStatus.NotDelivered,
      })

      try {
        await handleMessageReceived(username || '', socket.data.user?.email || '', receiverId, '[Encrypted message]', true, trimmed)
      } catch (err) {
        logWarn('[chat-service] notifyReceiver failed:', err)
      }

      return saved
    }

    const formatMessageForClient = (msg: any, username?: string) => ({
      _id: msg.id,
      id: msg.id,
      senderId: msg.senderId,
      senderUsername: username || undefined,
      senderName: username || undefined,
      receiverId: msg.receiverId,
      content: msg.message,
      message: msg.message,
      timestamp: msg.createdAt,
      createdAt: msg.createdAt,
      updatedAt: msg.updatedAt,
      read: false,
      isRead: false
    })

    socket.on('sendMessage', async (data, ack?: (res: { ok: boolean; id?: string; error?: string }) => void) => {
      try {
        const { senderId, receiverId, message, _id } = data
        const { username } = socket.data.user || { username: undefined }

        if (senderId !== userId) {
          ack?.({ ok: false, error: 'Unauthorized: cannot send as another user' })
          return
        }

        const trimmedMessage = validateMessage(message, ack)
        if (!trimmedMessage) return

        if (!receiverId || senderId === receiverId) {
          ack?.({ ok: false, error: 'Invalid receiver' })
          return
        }

        const messageRepo = AppDataSource.getRepository(Message)
        const msg = await retrieveOrSaveMessage({ _id, trimmed: trimmedMessage, senderId, receiverId, messageRepo, username, socket, ack })
        if (!msg) return

        const formattedMsg = formatMessageForClient(msg, username)

        logDebug('[chat-service] Broadcasting message to receiver:', receiverId, 'content length:', msg.message?.length)

        if (typingTimeouts.has(userId)) {
          clearTimeout(typingTimeouts.get(userId))
          typingTimeouts.delete(userId)
        }
        io.to(receiverId).emit('typing', { userId, isTyping: false })

        io.to(receiverId).emit('receiveMessage', formattedMsg)
        ack?.({ ok: true, id: msg.id })
      } catch (err) {
        logError('[chat-service] socket sendMessage error:', err)
        ack?.({ ok: false, error: 'Failed to send message' })
        socket.emit('server:error', { message: 'Failed to send message' })
      }
    })
  })
}

start().catch(err => {
  logError('[chat-service] Failed to start:', err)
  process.exit(1)
})

const exitHandler = () => {
  if (server) {
    server.close(() => {
      logInfo('[chat-service]: Server closed')
      process.exit(1)
    })
  } else {
    process.exit(1)
  }
}

const unexpectedErrorHandler = (error: unknown) => {
  logError('[chat-service]: Uncaught Exception', error)
  exitHandler()
}

process.on('uncaughtException', unexpectedErrorHandler)
process.on('unhandledRejection', unexpectedErrorHandler)