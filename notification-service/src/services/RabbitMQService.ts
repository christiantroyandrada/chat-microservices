import amqp, { Channel } from 'amqplib'
import config from '../config/config'
import { FCMService } from './FCMService'
import { SecureEmailService } from './SecureEmailService'
import { UserStatusStore } from '../utils'
import { Notification } from '../database'
import { NotificationType } from '../database/models/NotificationModel'
import { AppDataSource } from '../database/connection'
import { logError } from '../utils/logger'

class RabbitMQService {
  private channel!: Channel
  private readonly fcmService = FCMService
  private readonly emailService = new SecureEmailService()
  private readonly userStatusStore = new UserStatusStore()

  async connect () {
    // Ensure the broker URL is present at runtime and narrow its type for TS.
    const brokerUrl = config.msgBrokerURL
    if (!brokerUrl) {
      logError('[chat-service] MESSAGE_BROKER_URL is not configured')
      throw new Error('Missing MESSAGE_BROKER_URL')
    }
    const connection = await amqp.connect(brokerUrl)
    this.channel = await connection.createChannel()
    await this.consumeNotification()
  }

  async consumeNotification () {
    await this.channel.assertQueue(config.queue.notifications)
    this.channel.consume(config.queue.notifications, async (msg) => {
      if (!msg) return
      try {
        const payload = JSON.parse(msg.content.toString())
        await this.handleMessage(payload, msg)
      } catch (err) {
        logError('[notification-service] consumeNotification error:', err)
        // avoid infinite requeues on failure — nack and drop the message
        try {
          this.channel.nack(msg, false, false)
        } catch (e) {
          logError('[notification-service] failed to nack message:', e)
        }
      }
    })
  }

  private async handleMessage(payload: any, msg: any) {
    const {
      type,
      userId,
      message,
      envelope,
      isEncrypted,
      userEmail,
      userToken,
      fromName,
    } = payload

    if (type !== 'MESSAGE_RECEIVED') {
      this.channel.ack(msg)
      return
    }

    // Create notification record in database. For encrypted messages do not
    // persist plaintext — store a generic placeholder instead.
    const notificationRepo = AppDataSource.getRepository(Notification)
    const storedMessage = isEncrypted ? '[Encrypted message]' : (message || 'You have a new message')
    await notificationRepo.save({
      userId,
      type: NotificationType.MESSAGE,
      title: `New message from ${fromName || 'Unknown'}`,
      message: storedMessage,
      read: false
    })

    const online = this.userStatusStore.isUserOnline(userId)

    // If the recipient is online, send a push.
    if (online && userToken) {
      if (isEncrypted) {
        const dataPayload: Record<string, string> = {}
        if (envelope) dataPayload.envelope = typeof envelope === 'string' ? envelope : JSON.stringify(envelope)
        else if (message) dataPayload.envelope = message

        await this.fcmService.sendPushNotification(userToken, '[Encrypted message]', dataPayload)
        this.channel.ack(msg)
        return
      }

      // Not encrypted — send plaintext in push body
      await this.fcmService.sendPushNotification(userToken, message || 'You have a new message')
      this.channel.ack(msg)
      return
    }

    // If the user has an email configured, send a transactional email.
    if (userEmail) {
      const emailBody = isEncrypted ? 'You have a new encrypted message. Open the app to view it.' : (message || '')
      await this.emailService.sendEmail(
        userEmail,
        `New message from ${fromName}`,
        emailBody,
      )
      this.channel.ack(msg)
      return
    }

    // nothing to do for this message, acknowledge to remove from queue
    this.channel.ack(msg)
  }
}

export const rabbitMQService = new RabbitMQService()