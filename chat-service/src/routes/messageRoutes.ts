import { Router, RequestHandler } from 'express'
import MessageController from '../controllers/MessageController'
import { authMiddleware } from '../middleware'

const chatServiceRouter = Router()

chatServiceRouter.post(
  '/send',
  authMiddleware as RequestHandler,
  MessageController.sendMessage as unknown as RequestHandler
)
chatServiceRouter.get(
  '/get/:receiverId',
  authMiddleware as RequestHandler,
  MessageController.fetchConversation as unknown as RequestHandler
)
chatServiceRouter.get(
  '/conversations',
  authMiddleware as RequestHandler,
  MessageController.getConversations as unknown as RequestHandler
)
chatServiceRouter.put(
  '/messages/read/:senderId',
  authMiddleware as RequestHandler,
  MessageController.markAsRead as unknown as RequestHandler
)

export default chatServiceRouter