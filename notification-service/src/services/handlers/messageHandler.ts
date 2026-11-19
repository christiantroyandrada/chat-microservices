import { Notification } from '../../database'
import { NotificationType } from '../../database/models/NotificationModel'
import type { Channel, ConsumeMessage } from 'amqplib'
import type { Repository } from 'typeorm'
import { FCMService } from '../FCMService'
import { SecureEmailService } from '../SecureEmailService'
import { UserStatusStore } from '../../utils'
import { renderNotificationEmail } from '../NotificationEmail'
import { logError } from '../../utils/logger'
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

    const sendEmail = async () => {
      if (!userEmail) return
      const email = renderNotificationEmail({ fromName, message, isEncrypted })
      if (email) await emailService.sendEmail(userEmail, email.subject, email.html)
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
