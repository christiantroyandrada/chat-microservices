import { Router, RequestHandler } from 'express'
import rateLimit from 'express-rate-limit'
import NotificationController from '../controllers/NotificationController'
import { authMiddleware } from '../middleware/auth'

// General limiter for read/update/delete operations
const notificationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: 'Too many requests from this IP, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
})

// Tighter limiter for write (create) operations
const createNotificationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 30,
  message: 'Too many notification creation requests, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
})

const notificationRouter = Router()

// Apply general rate-limit to all notification routes
notificationRouter.use(notificationLimiter)

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
  createNotificationLimiter,
  authMiddleware as RequestHandler,
  NotificationController.createNotification as unknown as RequestHandler
)

export default notificationRouter
