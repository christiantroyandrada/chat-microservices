import { Router, RequestHandler } from 'express'
import MessageController from '../controllers/MessageController'
import { authMiddleware } from '../middleware'
import { validateRequest } from '../middleware/validation/validateRequest'
import {
  sendMessageValidation,
  fetchConversationValidation,
  getConversationsValidation,
  markAsReadValidation,
  acknowledgeDeliveryValidation
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
  ...getConversationsValidation,
  validateRequest,
  MessageController.getConversations as RequestHandler
)
chatServiceRouter.put(
  '/messages/read/:senderId',
  authMiddleware as RequestHandler,
  ...markAsReadValidation,
  validateRequest,
  MessageController.markAsRead as RequestHandler
)

chatServiceRouter.put(
  '/messages/read/:senderId/visible',
  authMiddleware as RequestHandler,
  ...markAsReadValidation,
  validateRequest,
  MessageController.markVisibleAsRead as RequestHandler
)

chatServiceRouter.put(
  '/messages/:messageId/delivered',
  authMiddleware as RequestHandler,
  ...acknowledgeDeliveryValidation,
  validateRequest,
  MessageController.acknowledgeDelivery as RequestHandler
)

export default chatServiceRouter
