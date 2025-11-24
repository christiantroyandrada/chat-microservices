import amqp, { Channel } from 'amqplib'
import config from '../config/config'
import { FCMService } from './FCMService'
import { SecureEmailService } from './SecureEmailService'
import { UserStatusStore } from '../utils'
import { Notification } from '../database'
import { NotificationType } from '../database/models/NotificationModel'
import { AppDataSource } from '../database/connection'
import { logError } from '../utils/logger'
import { loadTemplate, renderTemplate, loadLogoDataUri } from './EmailTemplateService'
import { handleMessageReceived } from './handlers/messageHandler'
import { handleUserRegistered } from './handlers/welcomeHandler'

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

  // Template and logo helpers moved to EmailTemplateService for modularity.

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
    const notificationRepo = AppDataSource.getRepository(Notification)

    // Handle known event types. MESSAGE_RECEIVED keeps the original behavior.
    switch (type) {
      case 'MESSAGE_RECEIVED': {
        await handleMessageReceived(payload, msg, {
          fcmService: this.fcmService,
          emailService: this.emailService,
          userStatusStore: this.userStatusStore,
          notificationRepo,
          channel: this.channel,
        })
        return
      }

      case 'USER_REGISTERED': {
        await handleUserRegistered(payload, msg, {
          emailService: this.emailService,
          notificationRepo,
          channel: this.channel,
        })
        return
      }

      // USER_LOGGED_IN events are intentionally ignored to limit notification
      // types to: registration and offline message alerts. If needed in future
      // this can be added back behind a feature flag.

      default: {
        // Unknown event types are ignored by the notification-service
        this.channel.ack(msg)
        return
      }
    }
  }
}

export const rabbitMQService = new RabbitMQService()