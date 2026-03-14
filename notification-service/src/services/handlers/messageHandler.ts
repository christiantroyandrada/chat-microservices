import { Notification } from '../../database'
import { NotificationType } from '../../database/models/NotificationModel'
import type { Channel, ConsumeMessage } from 'amqplib'
import type { Repository } from 'typeorm'
import { FCMService } from '../FCMService'
import { SecureEmailService } from '../SecureEmailService'
import { UserStatusStore } from '../../utils'
import { loadTemplate, renderTemplate } from '../EmailTemplateService'
import config from '../../config/config'
import { logError } from '../../utils/logger'
import { LOGO_URL, APP_URL } from '../../config/constants'
import type { MessageReceivedPayload } from '../../types'

type Deps = {
  fcmService: typeof FCMService
  emailService: SecureEmailService
  userStatusStore: UserStatusStore
  notificationRepo: Repository<Notification>
  channel: Channel
}

export async function handleMessageReceived (payload: MessageReceivedPayload, msg: ConsumeMessage, deps: Deps) {
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
      if (!userToken) return
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
      if (!userEmail) return
      const emailBody = isEncrypted ? 'You have a new encrypted message. Open the app to view it.' : (message || '')

      const html = renderTemplate(messageTpl, {
        TITLE: `New message from ${fromName || 'Unknown'}`,
        BODY: emailBody,
        APP_URL,
        YEAR: String(new Date().getFullYear()),
        EMAIL_FROM: config.EMAIL_FROM || 'notifications@chat-app',
        LOGO_DATA_URI: LOGO_URL,
      })

      await emailService.sendEmail(userEmail, `New message from ${fromName || 'Unknown'}`, html)
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
