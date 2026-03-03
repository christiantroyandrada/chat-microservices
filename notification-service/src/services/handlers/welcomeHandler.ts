import { Notification } from '../../database'
import { NotificationType } from '../../database/models/NotificationModel'
import type { Channel, ConsumeMessage } from 'amqplib'
import { SecureEmailService } from '../SecureEmailService'
import { loadTemplate, renderTemplate } from '../EmailTemplateService'
import config from '../../config/config'
import { logError } from '../../utils/logger'

type Deps = {
  emailService: SecureEmailService
  notificationRepo: any
  channel: Channel
}

export async function handleUserRegistered (payload: any, msg: ConsumeMessage, deps: Deps) {
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

        // Hard-coded public logo URL (preferred). This ensures mail clients fetch the image over HTTPS.
        const LOGO_URL = 'https://res.cloudinary.com/dpqt9h7cn/image/upload/v1764081536/logo_blqxwc.png'
        const logoSrc = LOGO_URL

        const html = renderTemplate(welcomeTpl, {
          BODY: welcomeMessage,
          APP_URL: (process.env.PUBLIC_URL || 'http://localhost:85'),
          YEAR: String(new Date().getFullYear()),
          EMAIL_FROM: config.EMAIL_FROM || 'notifications@chat-app',
          LOGO_DATA_URI: logoSrc,
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
