import { Response, Request } from 'express'
import { LRUCache } from 'lru-cache'
import type { ConversationRow } from '../types'
import { AuthenticatedRequest } from '../middleware'
import { Message, AppDataSource } from '../database'
import { APIError, handleMessageReceived } from '../utils'
import { logWarn, logError } from '../utils/logger'
import { MessageStatus } from '../database/models/MessageModel'

// LRU cache for user details — bounded to 500 entries with 60s TTL.
// Prevents unbounded memory growth from the old Map<string, ...> approach
// while still avoiding N+1 HTTP calls per conversation load.
// We wrap values in { data: ... } because LRU cache does not store null directly.
const USER_CACHE_TTL_MS = 60_000 // 1 minute TTL
type CachedUserDetail = { data: { username?: string } | null }
const userDetailCache = new LRUCache<string, CachedUserDetail>({
  max: 500,
  ttl: USER_CACHE_TTL_MS,
})

/** Clear the user detail cache — exposed for testing */
export const clearUserDetailCache = () => userDetailCache.clear()

const fetchUserDetails = async (userId: string, jwtToken?: string): Promise<{ username?: string } | null> => {
  // LRU cache handles TTL expiration automatically
  const cached = userDetailCache.get(userId)
  if (cached !== undefined) {
    return cached.data
  }

  try {
    const userServiceUrl = process.env.USER_SERVICE_URL || 'http://user:8081'
    const headers: Record<string, string> = {}
    // Forward JWT for service-to-service auth
    if (jwtToken) {
      headers['Cookie'] = `jwt=${jwtToken}`
    }
    const response = await fetch(`${userServiceUrl}/users/${userId}`, { headers })
    
    if (!response.ok) {
      logWarn(`Failed to fetch user ${userId}: ${response.status}`)
      return null
    }
    
    const data = await response.json()
    const result = data?.data || data || null

    // Store in LRU cache (TTL managed by lru-cache)
    userDetailCache.set(userId, { data: result })

    return result
  } catch (error) {
    logError(`Error fetching user ${userId}:`, error)
    return null
  }
}

/**
 * Batch-fetch user details for multiple user IDs.
 * Checks cache first, then fetches missing ones in parallel.
 */
const fetchUserDetailsBatch = async (userIds: string[], jwtToken?: string): Promise<Map<string, { username?: string } | null>> => {
  const results = new Map<string, { username?: string } | null>()
  const uncached: string[] = []

  for (const id of userIds) {
    const cached = userDetailCache.get(id)
    if (cached !== undefined) {
      results.set(id, cached.data)
    } else {
      uncached.push(id)
    }
  }

  // Fetch all uncached in parallel
  if (uncached.length > 0) {
    const fetched = await Promise.all(uncached.map(id => fetchUserDetails(id, jwtToken)))
    uncached.forEach((id, idx) => results.set(id, fetched[idx]))
  }

  return results
}

const sendMessage = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
  const { receiverId, message } = req.body
  const { _id, email, username } = req.user
    
    validateReceiver(_id, receiverId)

    // Validate message content - enforce end-to-end encrypted envelope
    if (!message || typeof message !== 'string') {
      throw new APIError(400, 'Invalid message content')
    }

    const trimmedMessage = message.trim()
    if (trimmedMessage.length === 0) {
      throw new APIError(400, 'Message cannot be empty')
    }

    if (trimmedMessage.length > 5000) {
      throw new APIError(400, 'Message exceeds maximum length of 5000 characters')
    }

    // Expect the client to send a Signal-style encrypted envelope encoded as JSON:
    // { __encrypted: true, type: number, body: <base64-string> }
    let parsedEnvelope: unknown = null
    try {
      parsedEnvelope = JSON.parse(trimmedMessage)
    } catch (e) {
      // Log the parsing error for diagnostics and then surface a user-friendly API error.
      // This counts as handling the exception (avoids swallowing it) and provides
      // useful context for debugging without exposing internals to clients.
      logWarn('Failed to parse encrypted message envelope', e)
      throw new APIError(400, 'Messages must be end-to-end encrypted (invalid envelope)')
    }

    // Narrow the parsed value and validate shape
    const envelopeCandidate = parsedEnvelope as { __encrypted?: boolean; body?: unknown } | null
    // Use optional chaining for concise null-safe checks
    if (envelopeCandidate?.__encrypted !== true || typeof envelopeCandidate?.body !== 'string') {
      throw new APIError(400, 'Messages must be end-to-end encrypted')
    }

    const messageRepo = AppDataSource.getRepository(Message)
    // Store the encrypted envelope as-is and mark as encrypted
    const newMessage = await messageRepo.save({
      senderId: _id,
      receiverId,
      message: trimmedMessage,
      isEncrypted: true,
      status: MessageStatus.NotDelivered,
    })

    // Notify receiver but avoid sending plaintext. Indicate an encrypted message
    // and include the envelope so the notification service can forward ciphertext
    // to the client if desired (still no server-side decryption).
    await handleMessageReceived(
      username,
      email,
      receiverId,
      '[Encrypted message]',
      true,
      trimmedMessage,
    )

    return res.json({
      status: 200,
      message: 'Message sent successfully',
      data: newMessage,
    })
  } catch (error: unknown) {
    if (error instanceof APIError) {
      return res.status(error.statusCode).json({
        status: error.statusCode,
        message: error.message,
      })
    }
    const message =
      error instanceof Error ? error.message : 'Internal Server Error'
    return res.status(500).json({
      status: 500,
      message,
    })
  }
}

const validateReceiver = (
  senderId: string,
  receiverId: string,
) => {
  if (!receiverId) {
    throw new APIError(404, 'Receiver ID is required')
  }
  if (senderId === receiverId) {
    throw new APIError(400, 'Sender and receiver cannot be the same user')
  }
}

const fetchConversation = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const { receiverId } = req.params
    const { _id: senderId } = req.user  

    // Pagination: defaults to last 50 messages, supports limit/offset via query params
    const limit = Math.min(Number(req.query.limit) || 50, 200) // max 200 per request
    const offset = Math.max(Number(req.query.offset) || 0, 0)
    
    const messageRepo = AppDataSource.getRepository(Message)
    const [messages, total] = await messageRepo
      .createQueryBuilder('message')
      .where('(message.senderId = :senderId AND message.receiverId = :receiverId) OR (message.senderId = :receiverId AND message.receiverId = :senderId)', 
        { senderId, receiverId })
      .orderBy('message.createdAt', 'DESC') // newest first for pagination
      .skip(offset)
      .take(limit)
      .getManyAndCount()

    // Reverse to chronological order for display
    messages.reverse()

    return res.json({
      status: 200,
      message: 'Conversation fetched successfully',
      data: messages,
      pagination: { total, limit, offset, hasMore: offset + limit < total },
    })
  } catch (error: unknown) {
    if (error instanceof APIError) {
      return res.status(error.statusCode).json({
        status: error.statusCode,
        message: error.message,
      })
    }
    const message = 
      error instanceof Error ? error.message : 'Internal Server Error'
    return res.status(500).json({
      status: 500,
      message,
    })
  }
}

const getConversations = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const { _id: userId } = req.user
    
    const messageRepo = AppDataSource.getRepository(Message)
    
    // Get all unique conversation partners with their last messages using SQL.
    // Uses UNION ALL instead of OR to let Postgres use individual B-tree indexes
    // on senderId and receiverId instead of a bitmap union scan.
    const conversationsRaw = await messageRepo.query(`
      WITH all_messages AS (
        SELECT "receiverId" as "userId",
               "senderId" as "lastMessageSenderId",
               message as "lastMessage",
               "createdAt" as "lastMessageTime"
        FROM messages
        WHERE "senderId" = $1
        UNION ALL
        SELECT "senderId" as "userId",
               "senderId" as "lastMessageSenderId",
               message as "lastMessage",
               "createdAt" as "lastMessageTime"
        FROM messages
        WHERE "receiverId" = $1
      ),
      ranked_messages AS (
        SELECT
          "userId",
          "lastMessageSenderId",
          "lastMessage",
          "lastMessageTime",
          ROW_NUMBER() OVER (
            PARTITION BY "userId"
            ORDER BY "lastMessageTime" DESC
          ) as rn
        FROM all_messages
      ),
      unread_counts AS (
        SELECT 
          "senderId" as "userId",
          COUNT(*) as "unreadCount"
        FROM messages
        WHERE "receiverId" = $1 AND status != 'Seen'
        GROUP BY "senderId"
      )
      SELECT 
        rm."userId",
        rm."lastMessageSenderId",
        rm."lastMessage",
        rm."lastMessageTime",
        COALESCE(uc."unreadCount", 0) as "unreadCount"
      FROM ranked_messages rm
      LEFT JOIN unread_counts uc ON rm."userId" = uc."userId"
      WHERE rm.rn = 1
      ORDER BY rm."lastMessageTime" DESC
    `, [userId])

    // Ensure we have an array even if the repo returns undefined/null
    const conversationsArray = Array.isArray(conversationsRaw) ? conversationsRaw : (conversationsRaw ? [conversationsRaw] : [])

    // Fetch usernames for all conversation partners in batch (avoids N+1 HTTP calls)
    // Forward JWT for service-to-service auth
    const jwtToken = req.cookies?.jwt
    const userIds = (conversationsArray as ConversationRow[]).map(c => c.userId)
    const userDetailsMap = await fetchUserDetailsBatch(userIds, jwtToken)

    // Use the shared ConversationRow type from src/types.ts
    const conversationsWithUsernames = (conversationsArray as ConversationRow[]).map((conv) => {
      const userDetails = userDetailsMap.get(conv.userId)
      return {
        ...conv,
        username: userDetails?.username || 'Unknown User'
      }
    })

    return res.json({
      status: 200,
      message: 'Conversations fetched successfully',
      data: conversationsWithUsernames,
    })
  } catch (error: unknown) {
    if (error instanceof APIError) {
      return res.status(error.statusCode).json({
        status: error.statusCode,
        message: error.message,
      })
    }
    const message = 
      error instanceof Error ? error.message : 'Internal Server Error'
    return res.status(500).json({
      status: 500,
      message,
    })
  }
}

const markAsRead = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const { senderId } = req.params
    const { _id: receiverId } = req.user

    if (!senderId) {
      throw new APIError(400, 'Sender ID is required')
    }

    const messageRepo = AppDataSource.getRepository(Message)
    
    // Mark all messages from senderId to the current user as read (Seen)
    const result = await messageRepo
      .createQueryBuilder()
      .update(Message)
      .set({ status: MessageStatus.Seen })
      .where('senderId = :senderId', { senderId })
      .andWhere('receiverId = :receiverId', { receiverId })
      .andWhere('status != :status', { status: MessageStatus.Seen })
      .execute()

    return res.json({
      status: 200,
      message: 'Messages marked as read',
      data: {
        modifiedCount: result.affected || 0
      }
    })
  } catch (error: unknown) {
    if (error instanceof APIError) {
      return res.status(error.statusCode).json({
        status: error.statusCode,
        message: error.message,
      })
    }
    const message = 
      error instanceof Error ? error.message : 'Internal Server Error'
    return res.status(500).json({
      status: 500,
      message,
    })
  }
}

export default {
  sendMessage,
  fetchConversation,
  getConversations,
  markAsRead,
}

// Also provide named exports to support CommonJS `require()` consumers in tests
export {
  sendMessage,
  fetchConversation,
  getConversations,
  markAsRead,
}