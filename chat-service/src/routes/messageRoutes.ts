import { Router, RequestHandler } from 'express'
import MessageController from '../controllers/MessageController'
import { authMiddleware } from '../middleware'
import { validateRequest } from '../middleware/validation/validateRequest'
import {
  sendMessageValidation,
  fetchConversationValidation,
  markAsReadValidation
} from '../middleware/validation/messageValidation'

const chatServiceRouter = Router()

chatServiceRouter.post(
  '/send',
  authMiddleware as RequestHandler,
  ...sendMessageValidation,
  validateRequest,
  MessageController.sendMessage as RequestHandler
)
chatServiceRouter.get(
  '/get/:receiverId',
  authMiddleware as RequestHandler,
  ...fetchConversationValidation,
  validateRequest,
  MessageController.fetchConversation as RequestHandler
)
chatServiceRouter.get(
  '/conversations',
  authMiddleware as RequestHandler,
  MessageController.getConversations as RequestHandler
)
chatServiceRouter.put(
  '/messages/read/:senderId',
  authMiddleware as RequestHandler,
  ...markAsReadValidation,
  validateRequest,
  MessageController.markAsRead as RequestHandler
)

export default chatServiceRouter