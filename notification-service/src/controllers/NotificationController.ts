import { Response } from 'express'
import { Notification, AppDataSource } from '../database'
import { APIError } from '../utils'
import { NotificationType } from '../database/models/NotificationModel'

interface AuthenticatedRequest extends Request {
  user?: {
    _id: string
    email: string
    name: string
  }
}

const getNotifications = async (
  req: AuthenticatedRequest & { query: { limit?: string; offset?: string } },
  res: Response
) => {
  try {
    const { _id: userId } = req.user!
    const limit = parseInt(req.query.limit || '20', 10)
    const offset = parseInt(req.query.offset || '0', 10)

    const notifRepo = AppDataSource.getRepository(Notification)
    const notifications = await notifRepo.find({
      where: { userId },
      order: { createdAt: 'DESC' },
      skip: offset,
      take: limit
    })

    return res.json({
      status: 200,
      message: 'Notifications fetched successfully',
      data: notifications
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Internal Server Error'
    return res.status(500).json({
      status: 500,
      message
    })
  }
}

const getUnreadCount = async (
  req: AuthenticatedRequest,
  res: Response
) => {
  try {
    const { _id: userId } = req.user!
    
    const notifRepo = AppDataSource.getRepository(Notification)
    const count = await notifRepo.count({
      where: { userId, read: false }
    })

    return res.json({
      status: 200,
      message: 'Unread count fetched successfully',
      data: { count }
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Internal Server Error'
    return res.status(500).json({
      status: 500,
      message
    })
  }
}

const markAsRead = async (
  req: AuthenticatedRequest & { params: { notificationId: string } },
  res: Response
) => {
  try {
    const { _id: userId } = req.user!
    const { notificationId } = req.params

    const notifRepo = AppDataSource.getRepository(Notification)
    const notification = await notifRepo.findOne({
      where: { id: notificationId, userId }
    })

    if (!notification) {
      throw new APIError(404, 'Notification not found')
    }

    notification.read = true
    await notifRepo.save(notification)

    return res.json({
      status: 200,
      message: 'Notification marked as read',
      data: notification
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Internal Server Error'
    const status = error instanceof APIError ? error.statusCode : 500
    return res.status(status).json({
      status,
      message
    })
  }
}

const markAllAsRead = async (
  req: AuthenticatedRequest,
  res: Response
) => {
  try {
    const { _id: userId } = req.user!

    const notifRepo = AppDataSource.getRepository(Notification)
    const result = await notifRepo
      .createQueryBuilder()
      .update(Notification)
      .set({ read: true })
      .where('userId = :userId', { userId })
      .andWhere('read = :read', { read: false })
      .execute()

    return res.json({
      status: 200,
      message: 'All notifications marked as read',
      data: { modifiedCount: result.affected || 0 }
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Internal Server Error'
    return res.status(500).json({
      status: 500,
      message
    })
  }
}

const deleteNotification = async (
  req: AuthenticatedRequest & { params: { notificationId: string } },
  res: Response
) => {
  try {
    const { _id: userId } = req.user!
    const { notificationId } = req.params

    const notifRepo = AppDataSource.getRepository(Notification)
    const notification = await notifRepo.findOne({
      where: { id: notificationId, userId }
    })

    if (!notification) {
      throw new APIError(404, 'Notification not found')
    }

    await notifRepo.remove(notification)

    return res.json({
      status: 200,
      message: 'Notification deleted successfully'
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Internal Server Error'
    const status = error instanceof APIError ? error.statusCode : 500
    return res.status(status).json({
      status,
      message
    })
  }
}

const createNotification = async (
  req: AuthenticatedRequest & { body: { userId?: string; type: string; title: string; message: string } },
  res: Response
) => {
  try {
    const { userId, type, title, message } = req.body
    
    // Validate required fields
    if (!userId || !type || !title || !message) {
      throw new APIError(400, 'Missing required fields: userId, type, title, message')
    }

    // Validate type
    if (!['message', 'system', 'alert'].includes(type)) {
      throw new APIError(400, 'Invalid notification type. Must be: message, system, or alert')
    }

    const notifRepo = AppDataSource.getRepository(Notification)
    const notification = await notifRepo.save({
      userId,
      type: type as NotificationType,
      title,
      message,
      read: false
    })

    return res.status(201).json({
      status: 201,
      message: 'Notification created successfully',
      data: notification
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Internal Server Error'
    const status = error instanceof APIError ? error.statusCode : 500
    return res.status(status).json({
      status,
      message
    })
  }
}

export default {
  getNotifications,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  deleteNotification,
  createNotification
}
