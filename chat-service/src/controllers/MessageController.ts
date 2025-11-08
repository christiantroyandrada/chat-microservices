import { Response } from 'express'
import { AuthenticatedRequest } from '../middleware'
import { Message } from '../database'
import { APIError, handleMessageReceived } from '../utils'

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
    
    // Get all unique conversation partners
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
          lastMessage: { $first: '$$ROOT' },
          unreadCount: {
            $sum: {
              $cond: [
                { $and: [
                  { $eq: ['$receiverId', userId] },
                  { $eq: ['$isRead', false] }
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
          lastMessage: 1,
          unreadCount: 1
        }
      }
    ])

    return res.json({
      status: 200,
      message: 'Conversations fetched successfully',
      data: conversations,
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
}