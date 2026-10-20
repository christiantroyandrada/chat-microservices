import amqp, { Channel, ChannelModel, ConsumeMessage } from 'amqplib'
import config from '../config/config'
import { User, AppDataSource } from '../database'
import { logInfo, logError, logWarn } from '../utils/logger'

const INITIAL_RECONNECT_DELAY_MS = 1000
const MAX_RECONNECT_DELAY_MS = 30_000
const SETUP_TIMEOUT_MS = 10_000

class RabbitMQService {
  private readonly requestQueue = 'USER_DETAILS_REQUEST'
  private readonly responseQueue = 'USER_DETAILS_RESPONSE'
  private channel: Channel | undefined
  private connection: ChannelModel | undefined
  private connectPromise: Promise<void> | undefined
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private retryAttempt = 0
  private shuttingDown = false
  private disconnectPromise: Promise<void> | undefined

  async connect (): Promise<void> {
    if (this.disconnectPromise) await this.disconnectPromise
    this.shuttingDown = false
    if (this.isHealthy()) return
    if (this.connectPromise) return this.connectPromise
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = undefined }
    this.connectPromise = this.setupConnection()
      .then(() => undefined)
      .catch((error) => {
        this.connectPromise = undefined
        this.scheduleReconnect()
        throw error
      })
      .finally(() => { this.connectPromise = undefined })
    return this.connectPromise
  }

  private async setupConnection (): Promise<void> {
    const brokerUrl = config.msgBrokerURL
    if (!brokerUrl) throw new Error('Missing MESSAGE_BROKER_URL')
    const connection = await amqp.connect(brokerUrl)
    let channel: Channel | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('RabbitMQ setup timed out')), SETUP_TIMEOUT_MS) })
    try {
      this.connection = connection
      connection.on('error', (err) => logError('[user-service] RabbitMQ connection error:', err))
      connection.on('close', () => {
        if (this.connection === connection) {
          this.connection = undefined
          this.channel = undefined
          if (!this.shuttingDown) this.scheduleReconnect()
        }
      })
      channel = await Promise.race([connection.createChannel(), deadline])
      channel.on('error', (err) => { if (this.channel === channel) logError('[user-service] RabbitMQ channel error:', err) })
      channel.on('close', () => {
        if (this.channel === channel) {
          this.channel = undefined
          this.connection = undefined
          if (!this.shuttingDown) this.scheduleReconnect()
        }
      })
      await Promise.race([
        (async () => {
          await channel!.assertQueue(this.requestQueue)
          await channel!.assertQueue(this.responseQueue)
          await channel!.assertQueue(process.env.NOTIFICATIONS_QUEUE || 'NOTIFICATIONS', { durable: true })
          await this.listenForRequests(channel!)
        })(),
        deadline
      ])
      if (this.shuttingDown) throw new Error('RabbitMQ service is shutting down')
      this.connection = connection
      this.channel = channel
      this.retryAttempt = 0
      logInfo('[user-service] RabbitMQ connected')
    } catch (error) {
      if (this.connection === connection) this.connection = undefined
      if (this.channel === channel) this.channel = undefined
      await this.closeResources(channel, connection)
      this.scheduleReconnect()
      throw error
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }

  private scheduleReconnect (): void {
    if (this.shuttingDown || this.retryTimer || this.connectPromise) return
    const delay = Math.min(INITIAL_RECONNECT_DELAY_MS * (2 ** this.retryAttempt), MAX_RECONNECT_DELAY_MS)
    this.retryAttempt += 1
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      this.connect().catch((error) => logError('[user-service] RabbitMQ reconnect failed:', error))
    }, delay)
    this.retryTimer.unref?.()
    logWarn(`[user-service] RabbitMQ reconnect scheduled in ${delay}ms`)
  }

  private async listenForRequests (channel: Channel): Promise<void> {
    await channel.consume(this.requestQueue, (msg) => {
      if (msg) void this.handleRequest(channel, msg).catch((error) => logError('[user-service] RabbitMQ request handling failed:', error))
    })
  }

  private async handleRequest (channel: Channel, msg: ConsumeMessage): Promise<void> {
    try {
      const { userId } = JSON.parse(msg.content.toString())
      const userDetails = await AppDataSource.getRepository(User).findOne({
        where: { id: userId },
        select: ['id', 'username', 'email', 'createdAt', 'updatedAt']
      })
      await this.sendResponse(channel, msg, userDetails)
    } catch (error) {
      logError('[user-service] RabbitMQ message handling failed:', error)
      await this.sendResponse(channel, msg, { error: 'Invalid message format' })
    } finally {
      try { channel.ack(msg) } catch (error) { logError('[user-service] RabbitMQ ACK failed:', error) }
    }
  }

  private async sendResponse (channel: Channel, msg: ConsumeMessage, body: unknown): Promise<void> {
    try {
      channel.sendToQueue(msg.properties.replyTo, Buffer.from(JSON.stringify(body)), { correlationId: msg.properties.correlationId })
    } catch (error) { logError('[user-service] RabbitMQ response failed:', error) }
  }

  async publishNotification (payload: Record<string, unknown>): Promise<boolean> {
    try {
      if (!this.channel) throw new Error('RabbitMQ channel is not initialized')
      this.channel.sendToQueue(process.env.NOTIFICATIONS_QUEUE || 'NOTIFICATIONS', Buffer.from(JSON.stringify(payload)))
      return true
    } catch (error) {
      logError('[user-service] publishNotification failed:', error)
      return false
    }
  }

  isHealthy (): boolean { return !!this.channel && !!this.connection }

  async disconnect (): Promise<void> {
    if (this.disconnectPromise) return this.disconnectPromise
    this.disconnectPromise = this.disconnectInternal()
    try { await this.disconnectPromise } finally { this.disconnectPromise = undefined }
  }

  private async disconnectInternal (): Promise<void> {
    this.shuttingDown = true
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = undefined }
    if (this.connectPromise) { try { await this.connectPromise } catch {} }
    const channel = this.channel
    const connection = this.connection
    this.channel = undefined
    this.connection = undefined
    await this.closeResources(channel, connection)
    logInfo('[user-service] RabbitMQ connection closed gracefully')
  }

  private async closeResources (channel?: Channel, connection?: ChannelModel): Promise<void> {
    try { await channel?.close() } catch (error) { logError('[user-service] Error closing RabbitMQ channel:', error) }
    try { await connection?.close() } catch (error) { logError('[user-service] Error closing RabbitMQ connection:', error) }
  }
}

export const rabbitMQService = new RabbitMQService()
