import amqp, { Channel, ChannelModel, ConsumeMessage } from 'amqplib'
import config from '../config/config'
import { logInfo, logWarn, logError } from '../utils/logger'
import { notificationInbox, PermanentNotificationError } from './NotificationInbox'
import { notificationsConsumedTotal } from '../utils/metrics'

const MAX_RECONNECT_ATTEMPTS = 10
const INITIAL_RECONNECT_DELAY_MS = 1000

class RabbitMQService {
  private channel!: Channel
  private connection!: ChannelModel
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

  async consumeNotification () {
    // Declare the notifications queue to MATCH the existing broker topology:
    // durable, NO dead-letter args. The live CloudAMQP queue was created without
    // a DLX; declaring x-dead-letter-exchange here (even '') throws
    // 406 PRECONDITION_FAILED. Producer and consumer must declare identical args.
    const channel = this.channel
    await channel.assertQueue(config.queue.notifications, { durable: true })
    await channel.prefetch(10)
    await channel.consume(config.queue.notifications, (msg) => {
      if (msg) void this.handleMessage(channel, msg).catch(() => logError('[notification-service] Consumer callback failed'))
    })
  }

  private async handleMessage(channel: Channel, msg: ConsumeMessage): Promise<void> {
    let payload: unknown
    try {
      if (msg.content.length > 100_000) throw new PermanentNotificationError('Notification payload too large')
      try { payload = JSON.parse(msg.content.toString()) }
      catch { throw new PermanentNotificationError('Invalid notification JSON') }
      await notificationInbox.accept(payload, msg.properties.messageId)
    } catch (error) {
      logError('[notification-service] Notification receipt failed')
      try { channel.nack(msg, false, !(error instanceof PermanentNotificationError)) }
      catch { logError('[notification-service] Notification rejection failed') }
      return
    }
    const type = (payload as { type?: unknown } | null)?.type
    notificationsConsumedTotal.inc({ type: type === 'MESSAGE_RECEIVED' || type === 'USER_REGISTERED' ? type : 'unknown' })
    try { channel.ack(msg) }
    catch { logError('[notification-service] Notification acknowledgement failed') }
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
