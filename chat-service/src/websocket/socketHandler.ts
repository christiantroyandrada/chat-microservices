import { Socket, Server as SocketIOServer } from 'socket.io'
import { Message, AppDataSource } from '../database'
import { MessageStatus } from '../database/models/MessageModel'
import { APIError } from '../utils/apiError'
import { canonicalUserId, UUID } from '../utils/messageIdentity'
import { MessageSubmissionService } from '../services/MessageSubmissionService'
import { markConversationSeen, markMessageDelivered } from '../services/messageReceipts'
import { logDebug, logInfo, logWarn, logError } from '../utils/logger'
import type { IPresenceStore } from '../services/PresenceStore'
import { chatMessagesSentTotal, chatPresenceChangesTotal } from '../utils/metrics'

// ── Typing-indicator state (per-node, intentionally local) ───────────────────
// Typing timeouts are ephemeral, auto-correcting signals.  A timeout firing on
// the originating node issues an io.to(receiverId).emit() that the Redis adapter
// forwards to all nodes — so there is no correctness issue keeping this local.
const typingTimeouts = new Map<string, NodeJS.Timeout>()
const messageSubmission = new MessageSubmissionService()

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
  const claimedId = socket.data.user?.id
  const userId = typeof claimedId === 'string' ? canonicalUserId(claimedId) : undefined

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

  socket.on('disconnect', () => {
    handleDisconnect(io, socket, userId, presenceStore).catch(() =>
      logError('[chat-service] Socket disconnect failed'),
    )
  })
  socket.on('typing', (data: { receiverId: string; isTyping: boolean }) => {
    if (userId && typeof data?.receiverId === 'string' && typeof data.isTyping === 'boolean') {
      handleTyping(io, userId, data)
    }
  })
  socket.on('sendMessage', (data, ack?) => {
    handleSendMessage(io, socket, userId, data, ack).catch(() =>
      logError('[chat-service] Socket send response failed'),
    )
  })
  socket.on('messageDelivered', (data: { messageId: string }) =>
    handleMessageDelivered(io, userId, data).catch(err =>
      logError('[chat-service] messageDelivered error:', err),
    ),
  )
  socket.on('markRead', (data: { senderId: string }) =>
    handleMarkRead(io, userId, data).catch(err =>
      logError('[chat-service] markRead error:', err),
    ),
  )
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
  const { isTyping } = data
  const receiverId = canonicalUserId(data.receiverId)
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
    timeout.unref?.()

    typingTimeouts.set(userId, timeout)
  } else {
    io.to(receiverId).emit('typing', { userId, isTyping: false })
  }
}

// ── Message sending ───────────────────────────────────────────────────────────

export async function retrieveOrSaveMessage(params: {
  _id?: string
  trimmed: string
  senderId: string
  receiverId: string
  messageRepo: ReturnType<typeof AppDataSource.getRepository<Message>>
  username?: string
  clientMessageId?: string
  socket: Socket
  ack?: (res: { ok: boolean; id?: string; error?: string }) => void
}): Promise<Message | null> {
  const { _id, trimmed, messageRepo, username, socket, ack, clientMessageId } = params
  const senderId = canonicalUserId(params.senderId)
  const receiverId = canonicalUserId(params.receiverId)

  if (_id !== undefined) {
    if (typeof _id !== 'string' || !UUID.test(_id)) {
      ack?.({ ok: false, error: 'Message not found' })
      return null
    }
    const existing = await messageRepo.findOne({ where: { id: _id } })
    if (!existing) {
      ack?.({ ok: false, error: 'Message not found' })
      return null
    }
    // Ownership guard (IDOR): the idempotent-resend path may only reuse a message
    // that belongs to THIS sender→receiver pair. Without this an authenticated
    // user could supply any message id and have an arbitrary stored message
    // re-delivered/replayed. Return the same opaque error so existence isn't leaked.
    if (existing.senderId !== senderId || existing.receiverId !== receiverId) {
      ack?.({ ok: false, error: 'Message not found' })
      return null
    }
    if (!existing.isEncrypted) {
      ack?.({ ok: false, error: 'Server policy: plaintext messages are not allowed' })
      return null
    }
    if (clientMessageId !== undefined && (typeof clientMessageId !== 'string' || !UUID.test(clientMessageId))) {
      throw new APIError(400, 'Client message ID must be a valid UUID')
    }
    if (existing.clientMessageId != null || clientMessageId !== undefined) {
      if (existing.clientMessageId !== clientMessageId?.toLowerCase() || existing.message !== trimmed) {
        throw new APIError(409, 'Client message ID already belongs to a different message')
      }
    }
    return existing
  }
  const { message, replayed } = await messageSubmission.submit({
    senderId,
    receiverId,
    encryptedEnvelope: trimmed,
    clientMessageId,
    senderName: username || '',
    senderEmail: socket.data.user?.email || '',
  })
  if (!replayed) chatMessagesSentTotal.inc({ channel: 'websocket' })
  return message
}

/**
 * Receiver confirms a message reached their device → mark Delivered (once) and
 * notify the original sender in real time. Ownership-checked: only the message's
 * receiver may mark it delivered.
 */
export async function handleMessageDelivered(
  io: SocketIOServer,
  userId: string | undefined,
  data: { messageId: string },
): Promise<void> {
  if (!userId || typeof data?.messageId !== 'string' || !UUID.test(data.messageId)) return
  const receiverId = canonicalUserId(userId)
  const messageId = canonicalUserId(data.messageId)
  const result = await markMessageDelivered(messageId, receiverId)
  if (result) io.to(result.senderId).emit('messageDelivered', { messageId, by: receiverId })
}

/**
 * Receiver opened the conversation → mark all messages from `senderId` to them
 * as Seen and notify the sender (read receipts). Scoped to the caller as the
 * receiver, so a user can only mark messages addressed to themselves.
 */
export async function handleMarkRead(
  io: SocketIOServer,
  userId: string | undefined,
  data: { senderId: string },
): Promise<void> {
  if (!userId || typeof data?.senderId !== 'string' || !UUID.test(data.senderId)) return
  userId = canonicalUserId(userId)
  const senderId = canonicalUserId(data.senderId)
  await markConversationSeen(senderId, userId)
  io.to(senderId).emit('messageRead', { by: userId })
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
    status: msg.status,
    isEncrypted: msg.isEncrypted,
    clientMessageId: msg.clientMessageId,
    read: msg.status === MessageStatus.Seen,
    isRead: msg.status === MessageStatus.Seen,
  }
}

async function handleSendMessage(
  io: SocketIOServer,
  socket: Socket,
  userId: string | undefined,
  data: { senderId: string; receiverId: string; message: string; _id?: string; clientMessageId?: string },
  ack?: (res: { ok: boolean; id?: string; error?: string }) => void,
): Promise<void> {
  let acknowledged = false
  const respond = (result: { ok: boolean; id?: string; error?: string }) => {
    if (acknowledged) return
    acknowledged = true
    if (!result.ok) logWarn('[chat-service] Socket send request rejected')
    if (typeof ack === 'function') {
      try { ack(result) } catch { logError('[chat-service] Socket acknowledgement failed') }
    } else if (!result.ok) {
      socket.emit('server:error', { message: result.error })
    }
  }
  try {
    const { message, _id, clientMessageId } = data
    const senderId = typeof data.senderId === 'string' ? canonicalUserId(data.senderId) : undefined
    const receiverId = typeof data.receiverId === 'string' ? canonicalUserId(data.receiverId) : undefined
    const { username } = socket.data.user || { username: undefined }

    if (!senderId || senderId !== userId) {
      respond({ ok: false, error: 'Unauthorized: cannot send as another user' })
      return
    }

    if (!receiverId || senderId === receiverId) {
      respond({ ok: false, error: 'Invalid receiver' })
      return
    }

    const messageRepo = AppDataSource.getRepository(Message)
    const msg = await retrieveOrSaveMessage({
      _id,
      trimmed: message,
      clientMessageId,
      senderId,
      receiverId,
      messageRepo,
      username,
      socket,
      ack: respond,
    })
    if (!msg) return

    const formattedMsg = formatMessageForClient(msg, username)
    logDebug('[chat-service] Broadcasting message to receiver:', receiverId, 'content length:', msg.message?.length)

    // Clear typing indicator on send
    if (userId && typingTimeouts.has(userId)) {
      clearTimeout(typingTimeouts.get(userId))
      typingTimeouts.delete(userId)
    }
    io.to(msg.receiverId).emit('typing', { userId, isTyping: false })
    io.to(msg.receiverId).emit('receiveMessage', formattedMsg)
    respond({ ok: true, id: msg.id })
  } catch (err) {
    respond({ ok: false, error: err instanceof APIError ? err.message : 'Failed to send message' })
  }
}
