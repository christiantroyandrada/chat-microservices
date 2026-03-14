import { Notification } from '../../database'
import { NotificationType } from '../../database/models/NotificationModel'
import type { Channel, ConsumeMessage } from 'amqplib'
import type { Repository } from 'typeorm'
import { SecureEmailService } from '../SecureEmailService'
import { loadTemplate, renderTemplate } from '../EmailTemplateService'
import config from '../../config/config'
import { logError } from '../../utils/logger'
import { LOGO_URL, APP_URL } from '../../config/constants'
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
        const welcomeTpl = loadTemplate('welcome.html')

        const html = renderTemplate(welcomeTpl, {
          BODY: welcomeMessage,
          APP_URL,
          YEAR: String(new Date().getFullYear()),
          EMAIL_FROM: config.EMAIL_FROM || 'notifications@chat-app',
          LOGO_DATA_URI: LOGO_URL,
        })

        await emailService.sendEmail(userEmail, 'Welcome to Chat App', html)
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
