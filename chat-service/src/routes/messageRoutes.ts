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

export default chatServiceRouter