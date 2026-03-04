import { Socket, Server as SocketIOServer } from 'socket.io'
import { Message, AppDataSource } from '../database'
import { MessageStatus } from '../database/models/MessageModel'
import { handleMessageReceived } from '../utils'
import { logDebug, logInfo, logWarn, logError } from '../utils/logger'
import type { IPresenceStore } from '../services/PresenceStore'
import { chatMessagesSentTotal, chatPresenceChangesTotal } from '../utils/metrics'

// ── Typing-indicator state (per-node, intentionally local) ───────────────────
// Typing timeouts are ephemeral, auto-correcting signals.  A timeout firing on
// the originating node issues an io.to(receiverId).emit() that the Redis adapter
// forwards to all nodes — so there is no correctness issue keeping this local.
let typingTimeouts = new Map<string, NodeJS.Timeout>()

// V8 never shrinks Map capacity after deletions.  Compact every 5 minutes so
// freed entries are actually reclaimed by the GC.
const COMPACT_INTERVAL_MS = 5 * 60 * 1000
setInterval(() => {
  const fresh = new Map<string, NodeJS.Timeout>()
  typingTimeouts.forEach((t, uid) => fresh.set(uid, t))
  typingTimeouts = fresh
  logDebug('[chat-service] Compacted typingTimeouts:', typingTimeouts.size)
}, COMPACT_INTERVAL_MS)

// ── Socket handler registration ───────────────────────────────────────────────

/**
 * Register all event handlers for a single Socket.IO connection.
 *
 * @param io            The Socket.IO server instance.
 * @param socket        The individual client socket.
 * @param presenceStore The active presence store (local or Redis-backed).
 */
export function registerSocketHandlers(
  io: SocketIOServer,
  socket: Socket,
  presenceStore: IPresenceStore,
): void {
  const userId = socket.data.user?.id as string | undefined

  if (userId) {
    // Fire-and-forget: errors are caught internally
    registerPresence(io, socket, userId, presenceStore).catch(err =>
      logError('[chat-service] registerPresence error:', err),
    )
    sendInitialPresence(socket, userId, presenceStore).catch(err =>
      logError('[chat-service] sendInitialPresence error:', err),
    )
  } else {
    logWarn('[chat-service] No userId found for socket:', socket.id)
  }

  socket.on('disconnect', () => handleDisconnect(io, socket, userId, presenceStore))
  socket.on('typing', (data: { receiverId: string; isTyping: boolean }) => {
    if (userId) handleTyping(io, userId, data)
  })
  socket.on('sendMessage', (data, ack?) => handleSendMessage(io, socket, userId, data, ack))
}

// ── Presence management ───────────────────────────────────────────────────────

async function registerPresence(
  io: SocketIOServer,
  socket: Socket,
  userId: string,
  presenceStore: IPresenceStore,
): Promise<void> {
  socket.join(userId)
  logDebug('[chat-service] User joined room:', userId, 'socket:', socket.id)

  const isFirst = await presenceStore.connect(userId, socket.id)
  if (isFirst) {
    logInfo('[chat-service] User came online:', userId)
    io.emit('presence', { userId, online: true })
    chatPresenceChangesTotal.inc({ direction: 'online' })
  }
}

async function sendInitialPresence(
  socket: Socket,
  userId: string,
  presenceStore: IPresenceStore,
): Promise<void> {
  // Single bulk payload instead of O(n) individual emits per user.
  const onlineUserIds = await presenceStore.getOnlineUserIds(userId)
  if (onlineUserIds.length > 0) {
    socket.emit('presenceBulk', { onlineUserIds })
  }
  logDebug('[chat-service] Sent bulk presence to:', userId, 'count:', onlineUserIds.length)
}

async function handleDisconnect(
  io: SocketIOServer,
  socket: Socket,
  userId: string | undefined,
  presenceStore: IPresenceStore,
): Promise<void> {
  logDebug('[chat-service] Client disconnected:', socket.id)

  if (userId) {
    // Clear typing indicator (local cleanup — no Redis needed)
    if (typingTimeouts.has(userId)) {
      clearTimeout(typingTimeouts.get(userId))
      typingTimeouts.delete(userId)
    }

    const isLast = await presenceStore.disconnect(userId, socket.id)
    if (isLast) {
      const lastSeen = new Date().toISOString()
      logInfo('[chat-service] User went offline:', userId, 'lastSeen:', lastSeen)
      io.emit('presence', { userId, online: false, lastSeen })
      chatPresenceChangesTotal.inc({ direction: 'offline' })
    }
  }
}

// ── Typing indicators ─────────────────────────────────────────────────────────

function handleTyping(
  io: SocketIOServer,
  userId: string,
  data: { receiverId: string; isTyping: boolean },
): void {
  const { receiverId, isTyping } = data
  logDebug('[chat-service] Typing event:', { userId, receiverId, isTyping })

  if (typingTimeouts.has(userId)) {
    clearTimeout(typingTimeouts.get(userId))
    typingTimeouts.delete(userId)
  }

  if (isTyping) {
    io.to(receiverId).emit('typing', { userId, isTyping: true })

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

// ── Message sending ───────────────────────────────────────────────────────────

function validateMessage(
  message: unknown,
  ack?: (res: { ok: boolean; id?: string; error?: string }) => void,
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
      trimmed,
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
  ack?: (res: { ok: boolean; id?: string; error?: string }) => void,
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
    chatMessagesSentTotal.inc({ channel: 'websocket' })
    ack?.({ ok: true, id: msg.id })
  } catch (err) {
    logError('[chat-service] socket sendMessage error:', err)
    ack?.({ ok: false, error: 'Failed to send message' })
    socket.emit('server:error', { message: 'Failed to send message' })
  }
}
