import { Router } from 'express'
import MessageController from '../controllers/MessageController'
import { authMiddleware } from '../middleware'

const messageRoutes = Router()

messageRoutes.post('/send', authMiddleware, MessageController.sendMessage)
messageRoutes.get(
  '/get/:receiverId',
  authMiddleware,
  MessageController.fetchConversation
)

export default messageRoutes