import amqp, { Channel, ChannelModel, ConsumeMessage } from 'amqplib'
import config from '../config/config'
import { logInfo, logWarn, logError } from '../utils/logger'
import { notificationInbox, PermanentNotificationError } from './NotificationInbox'
import { notificationsConsumedTotal } from '../utils/metrics'

class RabbitMQService {
  private channel?: Channel
  private connection?: ChannelModel
  private consumerTag?: string
  private connectPromise?: Promise<void>
  private disconnectPromise?: Promise<void>
  private retryTimer?: NodeJS.Timeout
  private retryAttempt = 0
  private shuttingDown = false
  private setupAbort?: AbortController
  private readonly receipts = new Set<Promise<void>>()
  private readonly closing = new Set<Promise<void>>()

  connect(): Promise<void> {
    if (this.shuttingDown) return Promise.reject(new Error('RabbitMQ is shutting down'))
    if (this.isHealthy()) return Promise.resolve()
    if (this.connectPromise) return this.connectPromise
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    const pending = this.setupConnection().finally(() => {
      if (this.connectPromise === pending) this.connectPromise = undefined
      if (!this.isHealthy()) this.scheduleReconnect()
    })
    this.connectPromise = pending
    return pending
  }

  private async setupConnection(): Promise<void> {
    if (!config.msgBrokerURL) throw new Error('Missing MESSAGE_BROKER_URL')
    const abort = new AbortController()
    this.setupAbort = abort
    const timeout = setTimeout(() => abort.abort(new Error('RabbitMQ setup timed out')), 10000)
    timeout.unref?.()
    let connection: ChannelModel | undefined
    let channel: Channel | undefined
    let promoted = false
    const failed = () => abort.abort(new Error('RabbitMQ transport failed during setup'))
    const cancel = () => { if (connection) this.destroySocket(connection) }
    abort.signal.addEventListener('abort', cancel, { once: true })
    try {
      connection = await amqp.connect(config.msgBrokerURL, { timeout: 10000, signal: abort.signal })
      const owner = connection
      connection.on('error', () => this.transportFailed(owner))
      connection.on('close', () => this.transportFailed(owner))
      connection.on('error', failed)
      connection.on('close', failed)
      abort.signal.throwIfAborted()
      channel = await connection.createChannel()
      channel.on('error', () => this.transportFailed(owner))
      channel.on('close', () => this.transportFailed(owner))
      channel.on('error', failed)
      channel.on('close', failed)
      abort.signal.throwIfAborted()
      // Preserve the existing durable queue topology without dead-letter arguments.
      await channel.assertQueue(config.queue.notifications, { durable: true })
      abort.signal.throwIfAborted()
      await channel.prefetch(10)
      abort.signal.throwIfAborted()
      const consumerChannel = channel
      const { consumerTag } = await channel.consume(config.queue.notifications, message => {
        if (this.shuttingDown || abort.signal.aborted || (promoted && this.connection !== owner)) return
        if (!message) {
          if (promoted) this.transportFailed(owner)
          else failed()
          return
        }
        const receipt = this.handleMessage(consumerChannel, message).catch(() => logError('[notification-service] Consumer callback failed'))
        this.receipts.add(receipt)
        void receipt.finally(() => this.receipts.delete(receipt))
      })
      abort.signal.throwIfAborted()
      if (this.shuttingDown) throw new Error('RabbitMQ is shutting down')
      this.connection = connection
      this.channel = channel
      this.consumerTag = consumerTag
      promoted = true
      this.retryAttempt = 0
      logInfo('[notification-service] RabbitMQ connected')
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

  private transportFailed(connection: ChannelModel): void {
    if (this.connection !== connection) return
    const channel = this.channel
    this.connection = undefined
    this.channel = undefined
    this.consumerTag = undefined
    this.destroySocket(connection)
    const cleanup = this.closeResources(channel, connection)
    this.closing.add(cleanup)
    void cleanup.finally(() => this.closing.delete(cleanup))
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.shuttingDown || this.retryTimer || this.connectPromise) return
    const delay = Math.min(1000 * 2 ** Math.min(this.retryAttempt++, 5), 30000)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      void this.connect().catch(() => logError('[notification-service] RabbitMQ reconnect failed'))
    }, delay)
    this.retryTimer.unref?.()
    logWarn(`[notification-service] RabbitMQ reconnect scheduled in ${delay}ms`)
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

  isHealthy(): boolean { return !this.shuttingDown && !!this.connection && !!this.channel && !!this.consumerTag }

  disconnect(): Promise<void> {
    if (this.disconnectPromise) return this.disconnectPromise
    this.shuttingDown = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    this.setupAbort?.abort(new Error('RabbitMQ is shutting down'))
    const channel = this.channel, connection = this.connection, tag = this.consumerTag
    this.channel = undefined
    this.connection = undefined
    this.consumerTag = undefined
    this.disconnectPromise = this.drain(channel, connection, tag)
    return this.disconnectPromise
  }

  private async drain(channel?: Channel, connection?: ChannelModel, tag?: string): Promise<void> {
    await this.connectPromise?.catch(() => undefined)
    if (channel && tag) {
      try { await this.bounded(() => channel.cancel(tag), connection) }
      catch { logError('[notification-service] RabbitMQ consumer cancellation failed') }
    }
    await Promise.allSettled(this.receipts)
    await this.closeResources(channel, connection)
    await Promise.allSettled(this.closing)
    logInfo('[notification-service] RabbitMQ connection closed gracefully')
  }

  private async bounded(work: () => Promise<unknown>, connection?: ChannelModel): Promise<void> {
    let timeout: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        work(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('RabbitMQ transport close timed out')), 1000)
          timeout.unref?.()
        }),
      ])
    } catch (error) {
      if (connection) this.destroySocket(connection)
      throw error
    } finally { if (timeout) clearTimeout(timeout) }
  }

  private async closeResources(channel?: Channel, connection?: ChannelModel): Promise<void> {
    for (const resource of [channel, connection]) {
      if (!resource) continue
      try { await this.bounded(() => resource.close(), connection) }
      catch { logError('[notification-service] RabbitMQ resource close failed') }
    }
  }

  private destroySocket(connection: ChannelModel): void {
    try {
      ;(connection as ChannelModel & { connection?: { stream?: { destroy(): void } } }).connection?.stream?.destroy()
    } catch { /* The socket is already gone. */ }
  }
}

export const rabbitMQService = new RabbitMQService()
