import amqp, { Channel, ChannelModel } from 'amqplib'
import config from '../config/config'
import { User, AppDataSource } from '../database'
import { APIError } from '../utils'
import { logInfo, logError, logWarn } from '../utils/logger'

const MAX_RECONNECT_ATTEMPTS = 10
const INITIAL_RECONNECT_DELAY_MS = 1000

class RabbitMQService {
  private readonly requestQueue = "USER_DETAILS_REQUEST"
  private readonly responseQueue = "USER_DETAILS_RESPONSE"
  private channel!: Channel
  private connection!: ChannelModel
  private reconnectAttempts = 0
  private isReconnecting = false

  async connect () {
    const brokerUrl = config.msgBrokerURL
    if (!brokerUrl) {
      logError('[user-service] MESSAGE_BROKER_URL is not configured')
      throw new Error('Missing MESSAGE_BROKER_URL')
    }

    this.connection = await amqp.connect(brokerUrl)
    this.channel = await this.connection.createChannel()
    this.reconnectAttempts = 0

    // Handle connection errors and closures for automatic reconnection
    this.connection.on('error', (err) => {
      logError('[user-service] RabbitMQ connection error:', err)
    })
    this.connection.on('close', () => {
      logWarn('[user-service] RabbitMQ connection closed. Attempting reconnect...')
      this.scheduleReconnect()
    })

    await this.channel.assertQueue(this.requestQueue)
    await this.channel.assertQueue(this.responseQueue)
    // Assert notification queue once at connect — avoids redundant RPC per publish
    const notifQueue = process.env.NOTIFICATIONS_QUEUE || 'NOTIFICATIONS'
    await this.channel.assertQueue(notifQueue, { durable: true })

    this.listenForRequests()
  }

  private scheduleReconnect () {
    if (this.isReconnecting) return
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      logError(`[user-service] RabbitMQ reconnect failed after ${MAX_RECONNECT_ATTEMPTS} attempts. Giving up.`)
      return
    }
    this.isReconnecting = true
    const delay = INITIAL_RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempts)
    this.reconnectAttempts++
    logInfo(`[user-service] RabbitMQ reconnect attempt ${this.reconnectAttempts} in ${delay}ms...`)
    setTimeout(async () => {
      try {
        await this.connect()
        logInfo('[user-service] RabbitMQ reconnected successfully')
      } catch (err) {
        logError('[user-service] RabbitMQ reconnect failed:', err)
      } finally {
        this.isReconnecting = false
      }
    }, delay)
  }

  private async listenForRequests () {
    this.channel.consume(this.requestQueue, async (msg) => {
        if (msg !== null) {
          try {
            const { userId } = JSON.parse(msg.content.toString())
            const userRepo = AppDataSource.getRepository(User)
            const userDetails = await userRepo.findOne({ 
              where: { id: userId },
              select: ['id', 'username', 'email', 'createdAt', 'updatedAt']
            })
            
            // Reply with user details
            this.channel.sendToQueue(
              msg.properties.replyTo,
              Buffer.from(JSON.stringify(userDetails)),
              { correlationId: msg.properties.correlationId }
            )
          } catch (parseError) {
            logError('[user-service] RabbitMQ message parse error:', parseError)
            // Send error response
            this.channel.sendToQueue(
              msg.properties.replyTo,
              Buffer.from(JSON.stringify({ error: 'Invalid message format' })),
              { correlationId: msg.properties.correlationId }
            )
          } finally {
            this.channel.ack(msg)
          }
        }
      })
  }

    /**
     * Publish a notification payload to the shared notifications queue.
     * Used by other services (e.g. auth) to notify the notification-service.
     */
    async publishNotification (payload: Record<string, unknown>) {
      try {
        if (!this.channel) throw new Error('RabbitMQ channel is not initialized')
        // Queue was asserted once during connect() — no need to re-assert per publish
        const q = process.env.NOTIFICATIONS_QUEUE || 'NOTIFICATIONS'
        this.channel.sendToQueue(q, Buffer.from(JSON.stringify(payload)))
        return true
      } catch (err) {
        logError('[user-service] publishNotification failed:', err)
        return false
      }
    }

    isHealthy (): boolean {
      return !!this.channel && !!this.connection
    }

    async disconnect (): Promise<void> {
      try {
        if (this.channel) await this.channel.close()
        if (this.connection) await this.connection.close()
        logInfo('[user-service] RabbitMQ connection closed gracefully')
      } catch (err) {
        logError('[user-service] Error closing RabbitMQ connection:', err)
      }
    }
}

export const rabbitMQService = new RabbitMQService()