import { Notification } from '../../database'
import { NotificationType } from '../../database/models/NotificationModel'
import type { Channel, ConsumeMessage } from 'amqplib'
import { FCMService } from '../FCMService'
import { SecureEmailService } from '../SecureEmailService'
import { UserStatusStore } from '../../utils'
import { loadTemplate, renderTemplate, loadLogoDataUri, loadLogoAttachment } from '../EmailTemplateService'
import config from '../../config/config'
import { logError } from '../../utils/logger'

type Deps = {
  fcmService: typeof FCMService
  emailService: SecureEmailService
  userStatusStore: UserStatusStore
  notificationRepo: any
  channel: Channel
}

export async function handleMessageReceived (payload: any, msg: ConsumeMessage, deps: Deps) {
  const { userId, message, envelope, isEncrypted, userEmail, userToken, fromName } = payload
  const { fcmService, emailService, userStatusStore, notificationRepo, channel } = deps

  try {
    const storedMessage = isEncrypted ? '[Encrypted message]' : (message || 'You have a new message')
    await notificationRepo.save({
      userId,
      type: NotificationType.MESSAGE,
      title: `New message from ${fromName || 'Unknown'}`,
      message: storedMessage,
      read: false,
    })

    const online = userStatusStore.isUserOnline(userId)

    const sendPush = async () => {
      if (isEncrypted) {
        const dataPayload: Record<string, string> = {}
        if (envelope) dataPayload.envelope = typeof envelope === 'string' ? envelope : JSON.stringify(envelope)
        else if (message) dataPayload.envelope = message

        await fcmService.sendPushNotification(userToken, '[Encrypted message]', dataPayload)
        return
      }

      await fcmService.sendPushNotification(userToken, message || 'You have a new message')
    }

    const messageTpl = loadTemplate('message.html')
    const sendEmail = async () => {
      const emailBody = isEncrypted ? 'You have a new encrypted message. Open the app to view it.' : (message || '')
      const logoAttachment = loadLogoAttachment()

      // Hard-coded public logo URL (preferred). This ensures mail clients fetch the image over HTTPS.
      const LOGO_URL = 'https://res.cloudinary.com/dpqt9h7cn/image/upload/v1764081536/logo_blqxwc.png'
      // Prefer the public URL and do not attach inline image when using the hosted logo.
      const logoSrc = LOGO_URL
      const attachments: { filename: string; contentBase64: string; cid?: string }[] | undefined = undefined

      const html = renderTemplate(messageTpl, {
        TITLE: `New message from ${fromName || 'Unknown'}`,
        BODY: emailBody,
        APP_URL: (process.env.PUBLIC_URL || 'http://localhost:85'),
        YEAR: String(new Date().getFullYear()),
        EMAIL_FROM: config.EMAIL_FROM || 'notifications@chat-app',
        LOGO_DATA_URI: logoSrc,
      })

      await emailService.sendEmail(userEmail, `New message from ${fromName || 'Unknown'}`, html, attachments)
    }

    if (online && userToken) {
      await sendPush()
      channel.ack(msg)
      return
    }

    if (userEmail) {
      await sendEmail()
      channel.ack(msg)
      return
    }

    channel.ack(msg)
  } catch (e) {
    logError('[messageHandler] error handling MESSAGE_RECEIVED', e)
    try { channel.nack(msg, false, false) } catch (er) { logError('[messageHandler] failed to nack', er) }
  }
}
