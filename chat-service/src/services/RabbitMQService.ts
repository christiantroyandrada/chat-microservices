import amqp, { Channel } from 'amqplib'
import { v4 as uuid_v4 } from 'uuid'
import config from '../config/config'
import type { NotificationPayload, UserDetails, UserDetailsCallback } from '../types'
import { logInfo, logError } from '../utils/logger'

class RabbitMQService {
  private readonly requestQueue = 'USER_DETAILS_REQUEST'
  private readonly responseQueue = 'USER_DETAILS_RESPONSE'
  // store callback + timeout so we can clean up if no response arrives
  private readonly correlationMap = new Map<string, { callback: UserDetailsCallback; timer: NodeJS.Timeout }>()
  private channel!: Channel

  async connect () {
    // Ensure the broker URL is present at runtime and narrow its type for TS.
    const brokerUrl = config.msgBrokerURL
    if (!brokerUrl) {
      logError('[chat-service] MESSAGE_BROKER_URL is not configured')
      throw new Error('Missing MESSAGE_BROKER_URL')
    }

    const connection = await amqp.connect(brokerUrl)
    this.channel = await connection.createChannel()
    await this.channel.assertQueue(this.requestQueue)
    await this.channel.assertQueue(this.responseQueue)

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

      await this.channel.assertQueue(config.queue.notifications)
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
}

export const rabbitMQService = new RabbitMQService()