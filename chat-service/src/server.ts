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
  await connectDB()

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


  // Track active user connections (userId -> Set of socket IDs)
  const activeUsers = new Map<string, Set<string>>();
  
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
        clearTimeout(typingTimeouts.get(userId)!);
        typingTimeouts.delete(userId);
      }

      // Update presence tracking
      if (userId && activeUsers.has(userId)) {
        const userSockets = activeUsers.get(userId)!;
        userSockets.delete(socket.id);

        // If user has no more active connections, mark as offline
        if (userSockets.size === 0) {
          activeUsers.delete(userId);
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
        clearTimeout(typingTimeouts.get(userId)!);
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
            logWarn('[chat-service] notifyReceiver failed:', err)
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
        
  logDebug('[chat-service] Broadcasting message to receiver:', receiverId, 'content length:', msg.message?.length)
        
        // Clear typing indicator for sender when message is sent
        if (typingTimeouts.has(userId)) {
          clearTimeout(typingTimeouts.get(userId)!);
          typingTimeouts.delete(userId);
        }
        // Notify receiver that sender stopped typing
        io.to(receiverId).emit('typing', {
          userId,
          isTyping: false
        });
        
        // Broadcast to receiver
        io.to(receiverId).emit('receiveMessage', formattedMsg)
        ack?.({ ok: true, id: msg.id })
      } catch (err) {
        logError('[chat-service] socket sendMessage error:', err)
        ack?.({ ok: false, error: 'Failed to send message' })
        // Prefer a namespaced error event vs. 'error' (which Socket.IO also uses internally)
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