import { Notification } from '../../database'
import { NotificationType } from '../../database/models/NotificationModel'
import type { Channel, ConsumeMessage } from 'amqplib'
import type { Repository } from 'typeorm'
import { SecureEmailService } from '../SecureEmailService'
import { renderNotificationEmail } from '../NotificationEmail'
import { logError } from '../../utils/logger'
import type { UserRegisteredPayload } from '../../types'

type Deps = {
  emailService: SecureEmailService
  notificationRepo: Repository<Notification>
  channel: Channel
}

export async function handleUserRegistered (payload: UserRegisteredPayload, msg: ConsumeMessage, deps: Deps) {
  const { userId, message, userEmail } = payload
  const { emailService, notificationRepo, channel } = deps

  try {
    const welcomeMessage = message || 'Thanks for registering. Welcome to Chat App!'
    await notificationRepo.save({
      userId,
      type: NotificationType.SYSTEM,
      title: 'Welcome to Chat App',
      message: welcomeMessage,
      read: false,
    })

    if (userEmail) {
      try {
        const email = renderNotificationEmail({ type: 'USER_REGISTERED' })
        if (email) await emailService.sendEmail(userEmail, email.subject, email.html)
      } catch (e) {
        logError('[welcomeHandler] Failed to send welcome email', e)
      }
    }

    channel.ack(msg)
  } catch (e) {
    logError('[welcomeHandler] error handling USER_REGISTERED', e)
    try { channel.nack(msg, false, false) } catch (er) { logError('[welcomeHandler] failed to nack', er) }
  }
}
