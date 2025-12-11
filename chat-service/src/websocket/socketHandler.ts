import { Socket, Server as SocketIOServer } from 'socket.io'
import { Message, AppDataSource } from '../database'
import { MessageStatus } from '../database/models/MessageModel'
import { handleMessageReceived, UserStatusStore } from '../utils'
import { logDebug, logInfo, logWarn, logError } from '../utils/logger'

// Track active user connections (userId -> Set of socket IDs)
const activeUsers = new Map<string, Set<string>>()

// Track typing status with timeout (userId -> timeout reference)
const typingTimeouts = new Map<string, NodeJS.Timeout>()

// In-process status store for presence tracking
const userStatusStore = UserStatusStore.getInstance()

/**
 * Register all event handlers for a single Socket.IO connection.
 * Extracted from server.ts for single-responsibility compliance.
 */
export function registerSocketHandlers(io: SocketIOServer, socket: Socket): void {
  const userId = socket.data.user?.id as string | undefined

  if (userId) {
    registerPresence(io, socket, userId)
    sendInitialPresence(socket, userId)
  } else {
    logWarn('[chat-service] No userId found for socket:', socket.id)
  }

  socket.on('disconnect', () => handleDisconnect(io, socket, userId))
  socket.on('receiveMessage', (message) => io.emit('receiveMessage', message))
  socket.on('typing', (data: { receiverId: string; isTyping: boolean }) => {
    if (userId) handleTyping(io, userId, data)
  })
  socket.on('sendMessage', (data, ack?) => handleSendMessage(io, socket, userId, data, ack))
}

// ---- Presence Management ----

function registerPresence(io: SocketIOServer, socket: Socket, userId: string): void {
  socket.join(userId)
  logDebug('[chat-service] User joined room:', userId, 'socket:', socket.id)

  if (!activeUsers.has(userId)) {
    activeUsers.set(userId, new Set())
  }
  activeUsers.get(userId)!.add(socket.id)
  userStatusStore.setUserOnline(userId)

  // First connection → broadcast online status
  if (activeUsers.get(userId)!.size === 1) {
    logInfo('[chat-service] User came online:', userId)
    io.emit('presence', { userId, online: true })
  }
}

function sendInitialPresence(socket: Socket, userId: string): void {
  activeUsers.forEach((sockets, onlineUserId) => {
    if (onlineUserId !== userId && sockets.size > 0) {
      socket.emit('presence', { userId: onlineUserId, online: true })
    }
  })
  logDebug('[chat-service] Sent initial presence state to:', userId, 'for', activeUsers.size - 1, 'other users')
}

function handleDisconnect(io: SocketIOServer, socket: Socket, userId: string | undefined): void {
  logDebug('[chat-service] Client disconnected:', socket.id)

  if (userId && typingTimeouts.has(userId)) {
    clearTimeout(typingTimeouts.get(userId))
    typingTimeouts.delete(userId)
  }

  if (userId && activeUsers.has(userId)) {
    const userSockets = activeUsers.get(userId)!
    userSockets.delete(socket.id)

    if (userSockets.size === 0) {
      activeUsers.delete(userId)
      userStatusStore.setUserOffline(userId)
      const lastSeen = new Date().toISOString()
      logInfo('[chat-service] User went offline:', userId, 'lastSeen:', lastSeen)
      io.emit('presence', { userId, online: false, lastSeen })
    }
  }
}

// ---- Typing Indicators ----

function handleTyping(
  io: SocketIOServer,
  userId: string,
  data: { receiverId: string; isTyping: boolean }
): void {
  const { receiverId, isTyping } = data
  logDebug('[chat-service] Typing event:', { userId, receiverId, isTyping })

  // Clear existing timeout
  if (typingTimeouts.has(userId)) {
    clearTimeout(typingTimeouts.get(userId))
    typingTimeouts.delete(userId)
  }

  if (isTyping) {
    io.to(receiverId).emit('typing', { userId, isTyping: true })

    // Auto-timeout: stop typing after 3 seconds of inactivity
    const timeout = setTimeout(() => {
      logDebug('[chat-service] Typing timeout for user:', userId)
      io.to(receiverId).emit('typing', { userId, isTyping: false })
      typingTimeouts.delete(userId)
    }, 3000)

    typingTimeouts.set(userId, timeout)
  } else {
    io.to(receiverId).emit('typing', { userId, isTyping: false })
  }
}

// ---- Message Sending ----

function validateMessage(
  message: unknown,
  ack?: (res: { ok: boolean; id?: string; error?: string }) => void
): string | null {
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

async function retrieveOrSaveMessage(params: {
  _id?: string
  trimmed: string
  senderId: string
  receiverId: string
  messageRepo: ReturnType<typeof AppDataSource.getRepository<Message>>
  username?: string
  socket: Socket
  ack?: (res: { ok: boolean; id?: string; error?: string }) => void
}): Promise<Message | null> {
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

  // Parse encrypted envelope
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
    await handleMessageReceived(
      username || '',
      socket.data.user?.email || '',
      receiverId,
      '[Encrypted message]',
      true,
      trimmed
    )
  } catch (err) {
    logWarn('[chat-service] notifyReceiver failed:', err)
  }

  return saved
}

function formatMessageForClient(msg: Message, username?: string) {
  return {
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
    isRead: false,
  }
}

async function handleSendMessage(
  io: SocketIOServer,
  socket: Socket,
  userId: string | undefined,
  data: { senderId: string; receiverId: string; message: string; _id?: string },
  ack?: (res: { ok: boolean; id?: string; error?: string }) => void
): Promise<void> {
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
    const msg = await retrieveOrSaveMessage({
      _id,
      trimmed: trimmedMessage,
      senderId,
      receiverId,
      messageRepo,
      username,
      socket,
      ack,
    })
    if (!msg) return

    const formattedMsg = formatMessageForClient(msg, username)
    logDebug('[chat-service] Broadcasting message to receiver:', receiverId, 'content length:', msg.message?.length)

    // Clear typing indicator on send
    if (userId && typingTimeouts.has(userId)) {
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
}
