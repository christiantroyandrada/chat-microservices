import { Response } from 'express'
import { AuthenticatedRequest } from '../middleware'
import { Message } from '../database'
import { APIError, handleMessageReceived } from '../utils'

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

    // Validate message content
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

    const newMessage = await Message.create({
      senderId: _id,
      receiverId,
      message: trimmedMessage,
    })

    await handleMessageReceived(
      name,
      email,
      receiverId,
      trimmedMessage
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
    const messages = await Message.find({
      $or: [
        { senderId, receiverId },
        { senderId: receiverId, receiverId: senderId },
      ]
    })

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
    
    // Get all unique conversation partners with their last messages
    const conversations = await Message.aggregate([
      {
        $match: {
          $or: [{ senderId: userId }, { receiverId: userId }]
        }
      },
      {
        $sort: { createdAt: -1 }
      },
      {
        $group: {
          _id: {
            $cond: [
              { $eq: ['$senderId', userId] },
              '$receiverId',
              '$senderId'
            ]
          },
          lastMessageDoc: { $first: '$$ROOT' },
          unreadCount: {
            $sum: {
              $cond: [
                { $and: [
                  { $eq: ['$receiverId', userId] },
                  { $ne: ['$status', 'Seen'] }
                ]},
                1,
                0
              ]
            }
          }
        }
      },
      {
        $project: {
          _id: 0,
          userId: '$_id',
          lastMessage: '$lastMessageDoc.message',
          lastMessageTime: '$lastMessageDoc.createdAt',
          unreadCount: 1
        }
      }
    ])

    // Fetch usernames for all conversation partners
    const conversationsWithUsernames = await Promise.all(
      conversations.map(async (conv) => {
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

    // Mark all messages from senderId to the current user as read (Seen)
    const result = await Message.updateMany(
      {
        senderId,
        receiverId,
        status: { $ne: 'Seen' }
      },
      {
        $set: { status: 'Seen' }
      }
    )

    return res.json({
      status: 200,
      message: 'Messages marked as read',
      data: {
        modifiedCount: result.modifiedCount
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