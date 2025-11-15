import { Response } from 'express'
import type { ConversationRow } from '../types'
import { AuthenticatedRequest } from '../middleware'
import { Message, AppDataSource } from '../database'
import { APIError, handleMessageReceived } from '../utils'
import { MessageStatus } from '../database/models/MessageModel'
import { Not } from 'typeorm'

// Helper to fetch user details from user service
const fetchUserDetails = async (userId: string): Promise<{ name: string } | null> => {
  try {
    const userServiceUrl = process.env.USER_SERVICE_URL || 'http://user:8081'
    const response = await fetch(`${userServiceUrl}/users/${userId}`)
    
    if (!response.ok) {
      console.warn(`Failed to fetch user ${userId}: ${response.status}`)
      return null
    }
    
    const data = await response.json()
    return data?.data || data || null
  } catch (error) {
    console.error(`Error fetching user ${userId}:`, error)
    return null
  }
}

const sendMessage = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const { receiverId, message } = req.body
    const { _id, email, name } = req.user
    
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
      throw new APIError(400, 'Messages must be end-to-end encrypted (invalid envelope)')
    }

    // Narrow the parsed value and validate shape
    const envelopeCandidate = parsedEnvelope as { __encrypted?: boolean; body?: unknown } | null
    if (!envelopeCandidate || envelopeCandidate.__encrypted !== true || typeof envelopeCandidate.body !== 'string') {
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
      name,
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
    const message =
      error instanceof Error ? error.message : 'Internal Server Error'
    return res.json({
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
    
    const messageRepo = AppDataSource.getRepository(Message)
    const messages = await messageRepo
      .createQueryBuilder('message')
      .where('(message.senderId = :senderId AND message.receiverId = :receiverId) OR (message.senderId = :receiverId AND message.receiverId = :senderId)', 
        { senderId, receiverId })
      .orderBy('message.createdAt', 'ASC')
      .getMany()

    return res.json({
      status: 200,
      message: 'Conversation fetched successfully',
      data: messages,
    })
  } catch (error: unknown) {
    const message = 
      error instanceof Error ? error.message : 'Internal Server Error'
    return res.json({
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
    
    // Get all unique conversation partners with their last messages using SQL
    const conversationsRaw = await messageRepo.query(`
      WITH ranked_messages AS (
        SELECT 
          CASE 
            WHEN "senderId" = $1 THEN "receiverId"
            ELSE "senderId"
          END as "userId",
          "senderId" as "lastMessageSenderId",
          message as "lastMessage",
          "createdAt" as "lastMessageTime",
          ROW_NUMBER() OVER (
            PARTITION BY CASE 
              WHEN "senderId" = $1 THEN "receiverId"
              ELSE "senderId"
            END 
            ORDER BY "createdAt" DESC
          ) as rn
        FROM messages
        WHERE "senderId" = $1 OR "receiverId" = $1
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

    // Fetch usernames for all conversation partners
    // Use the shared ConversationRow type from src/types.ts
    const conversationsWithUsernames = await Promise.all(
      (conversationsRaw as ConversationRow[]).map(async (conv) => {
        const userDetails = await fetchUserDetails(conv.userId)
        return {
          ...conv,
          username: userDetails?.name || 'Unknown User'
        }
      })
    )

    return res.json({
      status: 200,
      message: 'Conversations fetched successfully',
      data: conversationsWithUsernames,
    })
  } catch (error: unknown) {
    const message = 
      error instanceof Error ? error.message : 'Internal Server Error'
    return res.json({
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
    const message = 
      error instanceof Error ? error.message : 'Internal Server Error'
    return res.json({
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