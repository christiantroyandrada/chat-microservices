import { Response } from 'express'
import { AuthRequest } from '../middleware'
import { Message } from '../database'
import { APIError, handleReceivedMessage } from '../utils'

const sendMessage = async (
  req: AuthRequest,
  res: Response,
) => {
  try {
    const { receiverId, message } = req.body
    const { _id, email, name } = req.user
    
    validateReceiver(_id, receiverId)

    const newMessage = await Message.create({
      senderId: _id,
      receiverId,
      message,
    })

    await handleReceivedMessage(
      name,
      email,
      receiverId,
      message
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
  req: AuthRequest,
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

export default {
  sendMessage,
  fetchConversation,
}