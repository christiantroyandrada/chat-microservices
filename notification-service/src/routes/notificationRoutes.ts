import { Router, RequestHandler } from 'express'
import NotificationController from '../controllers/NotificationController'
import { authMiddleware } from '../middleware/auth'

const notificationRouter = Router()

// All routes require authentication
notificationRouter.get(
  '/',
  authMiddleware as RequestHandler,
  NotificationController.getNotifications as unknown as RequestHandler
)

notificationRouter.get(
  '/unread/count',
  authMiddleware as RequestHandler,
  NotificationController.getUnreadCount as unknown as RequestHandler
)

notificationRouter.put(
  '/read-all',
  authMiddleware as RequestHandler,
  NotificationController.markAllAsRead as unknown as RequestHandler
)

notificationRouter.put(
  '/:notificationId/read',
  authMiddleware as RequestHandler,
  NotificationController.markAsRead as unknown as RequestHandler
)

notificationRouter.delete(
  '/:notificationId',
  authMiddleware as RequestHandler,
  NotificationController.deleteNotification as unknown as RequestHandler
)

// Admin/system route for creating notifications (could add admin middleware later)
notificationRouter.post(
  '/',
  authMiddleware as RequestHandler,
  NotificationController.createNotification as unknown as RequestHandler
)

export default notificationRouter
