import amqp, { Channel, ChannelModel } from 'amqplib'
import config from '../config/config'
import { FCMService } from './FCMService'
import { SecureEmailService } from './SecureEmailService'
import { UserStatusStore } from '../utils'
import { Notification } from '../database'
import { NotificationType } from '../database/models/NotificationModel'
import { AppDataSource } from '../database/connection'
import { logInfo, logWarn, logError } from '../utils/logger'
import { loadTemplate, renderTemplate, loadLogoDataUri } from './EmailTemplateService'
import { handleMessageReceived } from './handlers/messageHandler'
import { handleUserRegistered } from './handlers/welcomeHandler'
import { notificationsConsumedTotal } from '../utils/metrics'

const MAX_RECONNECT_ATTEMPTS = 10
const INITIAL_RECONNECT_DELAY_MS = 1000

class RabbitMQService {
  private channel!: Channel
  private connection!: ChannelModel
  private readonly fcmService = FCMService
  private readonly emailService = new SecureEmailService()
  private readonly userStatusStore = UserStatusStore.getInstance()
  private reconnectAttempts = 0
  private isReconnecting = false

  async connect () {
    const brokerUrl = config.msgBrokerURL
    if (!brokerUrl) {
      logError('[notification-service] MESSAGE_BROKER_URL is not configured')
      throw new Error('Missing MESSAGE_BROKER_URL')
    }
    this.connection = await amqp.connect(brokerUrl)
    this.channel = await this.connection.createChannel()
    this.reconnectAttempts = 0

    // Handle connection errors and closures for automatic reconnection
    this.connection.on('error', (err) => {
      logError('[notification-service] RabbitMQ connection error:', err)
    })
    this.connection.on('close', () => {
      logWarn('[notification-service] RabbitMQ connection closed. Attempting reconnect...')
      this.scheduleReconnect()
    })

    await this.consumeNotification()
  }

  private scheduleReconnect () {
    if (this.isReconnecting) return
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      logError(`[notification-service] RabbitMQ reconnect failed after ${MAX_RECONNECT_ATTEMPTS} attempts. Giving up.`)
      return
    }
    this.isReconnecting = true
    const delay = INITIAL_RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempts)
    this.reconnectAttempts++
    logInfo(`[notification-service] RabbitMQ reconnect attempt ${this.reconnectAttempts} in ${delay}ms...`)
    setTimeout(async () => {
      try {
        await this.connect()
        logInfo('[notification-service] RabbitMQ reconnected successfully')
      } catch (err) {
        logError('[notification-service] RabbitMQ reconnect failed:', err)
      } finally {
        this.isReconnecting = false
      }
    }, delay)
  }

  // Template and logo helpers moved to EmailTemplateService for modularity.

  async consumeNotification () {
    // Assert dead-letter queue for failed messages
    const dlqName = `${config.queue.notifications}_DLQ`
    await this.channel.assertQueue(dlqName, { durable: true })

    // Assert main queue with dead-letter routing
    await this.channel.assertQueue(config.queue.notifications, {
      durable: true,
      deadLetterExchange: '',
      deadLetterRoutingKey: dlqName,
    })

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

    notificationsConsumedTotal.inc({ type: type || 'unknown' })

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

  isHealthy (): boolean {
    return !!this.channel && !!this.connection
  }

  async disconnect (): Promise<void> {
    try {
      if (this.channel) await this.channel.close()
      if (this.connection) await this.connection.close()
      logInfo('[notification-service] RabbitMQ connection closed gracefully')
    } catch (err) {
      logError('[notification-service] Error closing RabbitMQ connection:', err)
    }
  }
}

export const rabbitMQService = new RabbitMQService()