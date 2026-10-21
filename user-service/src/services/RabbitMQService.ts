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
  private setupAbort: AbortController | undefined
  private readonly closing = new Set<Promise<void>>()

  async connect (): Promise<void> {
    if (this.disconnectPromise) await this.disconnectPromise
    if (this.isHealthy()) return
    if (this.connectPromise) return this.connectPromise
    this.shuttingDown = false
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = undefined }
    const pending = this.setupConnection()
    this.connectPromise = pending
    try { await pending } finally {
      if (this.connectPromise === pending) this.connectPromise = undefined
      if (!this.isHealthy()) this.scheduleReconnect()
    }
  }

  private async setupConnection (): Promise<void> {
    const brokerUrl = config.msgBrokerURL
    if (!brokerUrl) throw new Error('Missing MESSAGE_BROKER_URL')
    const abort = new AbortController()
    this.setupAbort = abort
    const timeout = setTimeout(() => abort.abort(new Error('RabbitMQ setup timed out')), SETUP_TIMEOUT_MS)
    timeout.unref?.()
    let connection: ChannelModel | undefined
    let channel: Channel | undefined
    const failed = () => abort.abort(new Error('RabbitMQ transport failed during setup'))
    const cancel = () => { if (connection) this.destroySocket(connection) }
    abort.signal.addEventListener('abort', cancel, { once: true })
    try {
      // amqplib passes signal to the native socket; timeout alone only limits inactivity.
      connection = await amqp.connect(brokerUrl, { timeout: SETUP_TIMEOUT_MS, signal: abort.signal })
      connection.on('error', failed)
      connection.on('close', failed)
      abort.signal.throwIfAborted()
      channel = await connection.createChannel()
      channel.on('error', failed)
      channel.on('close', failed)
      abort.signal.throwIfAborted()
      await channel.assertQueue(this.requestQueue)
      abort.signal.throwIfAborted()
      await channel.assertQueue(this.responseQueue)
      abort.signal.throwIfAborted()
      await channel.assertQueue(process.env.NOTIFICATIONS_QUEUE || 'NOTIFICATIONS', { durable: true })
      abort.signal.throwIfAborted()
      await this.listenForRequests(channel)
      abort.signal.throwIfAborted()
      this.connection = connection
      this.channel = channel
      this.retryAttempt = 0
      const owner = connection
      connection.on('error', () => this.transportFailed(owner))
      connection.on('close', () => this.transportFailed(owner))
      channel.on('error', () => this.transportFailed(owner))
      channel.on('close', () => this.transportFailed(owner))
      logInfo('[user-service] RabbitMQ connected')
    } catch (error) {
      await this.closeResources(channel, connection)
      throw error
    } finally {
      clearTimeout(timeout)
      abort.signal.removeEventListener('abort', cancel)
      connection?.off('error', failed)
      connection?.off('close', failed)
      channel?.off('error', failed)
      channel?.off('close', failed)
      if (this.setupAbort === abort) this.setupAbort = undefined
    }
  }

  private transportFailed (connection: ChannelModel): void {
    if (this.connection !== connection) return
    const channel = this.channel
    this.connection = undefined
    this.channel = undefined
    this.destroySocket(connection)
    const cleanup = this.closeResources(channel, connection)
    this.closing.add(cleanup)
    void cleanup.finally(() => { this.closing.delete(cleanup) })
    this.scheduleReconnect()
  }

  private scheduleReconnect (): void {
    if (this.shuttingDown || this.retryTimer || this.connectPromise) return
    const delay = Math.min(INITIAL_RECONNECT_DELAY_MS * (2 ** Math.min(this.retryAttempt, 5)), MAX_RECONNECT_DELAY_MS)
    this.retryAttempt += 1
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      this.connect().catch(() => logError('[user-service] RabbitMQ reconnect failed'))
    }, delay)
    this.retryTimer.unref?.()
    logWarn(`[user-service] RabbitMQ reconnect scheduled in ${delay}ms`)
  }

  private async listenForRequests (channel: Channel): Promise<void> {
    await channel.consume(this.requestQueue, (msg) => {
      if (msg) void this.handleRequest(channel, msg).catch(() => logError('[user-service] RabbitMQ request handling failed'))
    })
  }

  private async handleRequest (channel: Channel, msg: ConsumeMessage): Promise<void> {
    try {
      const { userId } = JSON.parse(msg.content.toString())
      if (typeof userId !== 'string' || !userId.trim()) throw new Error('Invalid userId')
      const userDetails = await AppDataSource.getRepository(User).findOne({
        where: { id: userId },
        select: ['id', 'username', 'email', 'createdAt', 'updatedAt']
      })
      await this.sendResponse(channel, msg, userDetails)
    } catch {
      logError('[user-service] RabbitMQ message handling failed')
      await this.sendResponse(channel, msg, { error: 'Invalid message format' })
    } finally {
      try { channel.ack(msg) } catch { logError('[user-service] RabbitMQ ACK failed') }
    }
  }

  private async sendResponse (channel: Channel, msg: ConsumeMessage, body: unknown): Promise<void> {
    try {
      channel.sendToQueue(msg.properties.replyTo, Buffer.from(JSON.stringify(body)), { correlationId: msg.properties.correlationId })
    } catch { logError('[user-service] RabbitMQ response failed') }
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
    this.setupAbort?.abort(new Error('RabbitMQ setup cancelled'))
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = undefined }
    if (this.connectPromise) { try { await this.connectPromise } catch {} }
    const channel = this.channel
    const connection = this.connection
    this.channel = undefined
    this.connection = undefined
    await this.closeResources(channel, connection)
    await Promise.all(this.closing)
    logInfo('[user-service] RabbitMQ connection closed gracefully')
  }

  private async closeResources (channel?: Channel, connection?: ChannelModel): Promise<void> {
    for (const resource of [channel, connection]) {
      if (!resource) continue
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          resource.close(),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error('RabbitMQ close timed out')), 1000)
            timeout.unref?.()
          })
        ])
      } catch {
        if (connection) this.destroySocket(connection)
        logError('[user-service] RabbitMQ resource close failed')
      } finally { if (timeout) clearTimeout(timeout) }
    }
  }

  private destroySocket (connection: ChannelModel): void {
    try {
      ;(connection as ChannelModel & { connection?: { stream?: { destroy(): void } } }).connection?.stream?.destroy()
    } catch { /* The socket is already gone. */ }
  }
}

export const rabbitMQService = new RabbitMQService()
