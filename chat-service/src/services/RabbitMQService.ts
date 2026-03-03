import amqp, { Channel, ChannelModel } from 'amqplib'
import { v4 as uuid_v4 } from 'uuid'
import config from '../config/config'
import type { NotificationPayload, UserDetails, UserDetailsCallback } from '../types'
import { logInfo, logWarn, logError } from '../utils/logger'

const MAX_RECONNECT_ATTEMPTS = 10
const INITIAL_RECONNECT_DELAY_MS = 1000

class RabbitMQService {
  private readonly requestQueue = 'USER_DETAILS_REQUEST'
  private readonly responseQueue = 'USER_DETAILS_RESPONSE'
  // store callback + timeout so we can clean up if no response arrives
  private readonly correlationMap = new Map<string, { callback: UserDetailsCallback; timer: NodeJS.Timeout }>()
  private channel!: Channel
  private connection!: ChannelModel
  private reconnectAttempts = 0
  private isReconnecting = false

  async connect () {
    const brokerUrl = config.msgBrokerURL
    if (!brokerUrl) {
      logError('[chat-service] MESSAGE_BROKER_URL is not configured')
      throw new Error('Missing MESSAGE_BROKER_URL')
    }

    this.connection = await amqp.connect(brokerUrl)
    this.channel = await this.connection.createChannel()
    this.reconnectAttempts = 0

    // Handle connection errors and closures for automatic reconnection
    this.connection.on('error', (err) => {
      logError('[chat-service] RabbitMQ connection error:', err)
    })
    this.connection.on('close', () => {
      logWarn('[chat-service] RabbitMQ connection closed. Attempting reconnect...')
      this.scheduleReconnect()
    })

    await this.channel.assertQueue(this.requestQueue)
    await this.channel.assertQueue(this.responseQueue)
    // Assert notification queue once at connect — avoids redundant RPC per publish
    await this.channel.assertQueue(config.queue.notifications)

    this.channel.consume(
      this.responseQueue,
      (msg) => {
        if (!msg) return
        try {
          const correlationId = msg.properties.correlationId
          const user = JSON.parse(msg.content.toString()) as UserDetails

          const entry = this.correlationMap.get(correlationId)
          if (entry) {
            clearTimeout(entry.timer)
            entry.callback(user)
            this.correlationMap.delete(correlationId)
          }
          } catch (parseError) {
          // parse errors are unexpected - surface via logger
          logError('[chat-service] RabbitMQ response parse error:', parseError)
        }
      },
      { noAck: true },
    )
  }

  private scheduleReconnect () {
    if (this.isReconnecting) return
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      logError(`[chat-service] RabbitMQ reconnect failed after ${MAX_RECONNECT_ATTEMPTS} attempts. Giving up.`)
      return
    }
    this.isReconnecting = true
    const delay = INITIAL_RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempts)
    this.reconnectAttempts++
    logInfo(`[chat-service] RabbitMQ reconnect attempt ${this.reconnectAttempts} in ${delay}ms...`)
    setTimeout(async () => {
      try {
        await this.connect()
        logInfo('[chat-service] RabbitMQ reconnected successfully')
      } catch (err) {
        logError('[chat-service] RabbitMQ reconnect failed:', err)
      } finally {
        this.isReconnecting = false
      }
    }, delay)
  }

  async getUserDetails (userId: string, callback: UserDetailsCallback) {
    const correlationId = uuid_v4()
    const timer = setTimeout(() => {
      const entry = this.correlationMap.get(correlationId)
      if (entry) {
        // call the callback with null to indicate timeout
        try {
          entry.callback(null)
        } catch (e) {
          // callback threw during timeout handling — log via centralized logger
          logError('[chat-service] getUserDetails callback error after timeout', e)
        }
        this.correlationMap.delete(correlationId)
      }
    }, 5000)

    this.correlationMap.set(correlationId, { callback, timer })
    this.channel.sendToQueue(
      this.requestQueue,
      Buffer.from(JSON.stringify({ userId })),
      { correlationId },
    )
  }

  async notifyReceiver (
    receiverId: string,
    messageContent: string,
    senderEmail: string,
    senderName: string,
    isEncrypted = false,
    envelope?: string | object,
  ) {
  try {
      // Send notification payload to queue
      // The notification-service will handle user details lookup if needed
      const notificationPayload: NotificationPayload = {
        type: 'MESSAGE_RECEIVED',
        userId: receiverId,
        message: messageContent,
        from: senderEmail,
        fromName: senderName,
        isEncrypted: Boolean(isEncrypted),
      }

      if (envelope) {
        notificationPayload.envelope = envelope
      }

      // Queue was asserted once during connect() — no need to re-assert per publish
      this.channel.sendToQueue(
        config.queue.notifications,
        Buffer.from(JSON.stringify(notificationPayload)),
      )
    // use centralized logger for server-side ops
    logInfo('[chat-service] Notification sent to queue for user:', receiverId)
    } catch (error) {
    logError('[chat-service] Failed to send notification to queue:', error)
    }
  }

  isHealthy (): boolean {
    return !!this.channel && !!this.connection
  }

  async disconnect (): Promise<void> {
    try {
      if (this.channel) await this.channel.close()
      if (this.connection) await this.connection.close()
      logInfo('[chat-service] RabbitMQ connection closed gracefully')
    } catch (err) {
      logError('[chat-service] Error closing RabbitMQ connection:', err)
    }
  }
}

export const rabbitMQService = new RabbitMQService()