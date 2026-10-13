import { randomUUID } from 'node:crypto'
import amqp, { Channel, ChannelModel, ConfirmChannel } from 'amqplib'
import config from '../config/config'
import type { NotificationPayload, UserDetails, UserDetailsCallback } from '../types'
import { logError, logInfo, logWarn } from '../utils/logger'

const CONNECT_TIMEOUT_MS = 2000
const OPERATION_TIMEOUT_MS = 5000
const CLOSE_TIMEOUT_MS = 1000
const INITIAL_RECONNECT_DELAY_MS = 1000
const MAX_RECONNECT_DELAY_MS = 30000

export interface NotifyReceiverArgs {
  receiverId: string
  messageContent: string
  senderEmail: string
  senderName: string
  senderId?: string
  eventId?: string
  isEncrypted?: boolean
  envelope?: string | object
  receiverEmail?: string
  receiverToken?: string
  recipientOnline?: boolean
}

type PendingRequest = {
  callback: UserDetailsCallback
  timer: NodeJS.Timeout
}

type SocketBackedConnection = ChannelModel & {
  connection?: { stream?: { destroy(): void } }
}

export class RabbitMQService {
  private readonly requestQueue = 'USER_DETAILS_REQUEST'
  private responseQueue = ''
  private readonly correlationMap = new Map<string, PendingRequest>()
  private rpcChannel?: Channel
  private publisherChannel?: ConfirmChannel
  private connection?: ChannelModel
  private connecting?: Promise<void>
  private disconnecting?: Promise<void>
  private reconnectTimer?: NodeJS.Timeout
  private reconnectAttempts = 0
  private intentionalDisconnect = false
  private healthy = false

  constructor(private readonly brokerUrl: string | undefined = config.msgBrokerURL) {}

  async connect(): Promise<void> {
    if (this.healthy) return
    if (this.connecting) return this.connecting

    this.intentionalDisconnect = false
    const pending = this.initialize()
    this.connecting = pending
    let failed = false
    try {
      await pending
    } catch (error) {
      failed = true
      throw error
    } finally {
      if (this.connecting === pending) this.connecting = undefined
      if ((failed || !this.healthy) && !this.intentionalDisconnect) this.scheduleReconnect()
    }
  }

  private async initialize(): Promise<void> {
    if (!this.brokerUrl) {
      throw new Error('Missing MESSAGE_BROKER_URL')
    }

    const connection = await amqp.connect(this.brokerUrl, { timeout: CONNECT_TIMEOUT_MS })
    let rpcChannel: Channel | undefined
    let publisherChannel: ConfirmChannel | undefined
    try {
      rpcChannel = await this.withDeadline(
        connection.createChannel(),
        () => this.destroySocket(connection),
        'RabbitMQ RPC channel setup timed out',
      )
      publisherChannel = await this.withDeadline(
        connection.createConfirmChannel(),
        () => this.destroySocket(connection),
        'RabbitMQ publisher channel setup timed out',
      )
      await this.withDeadline(
        Promise.all([
          rpcChannel.assertQueue(this.requestQueue),
          publisherChannel.assertQueue(config.queue.notifications, { durable: true }),
        ]),
        () => this.destroySocket(connection),
        'RabbitMQ queue setup timed out',
      )
      const replyQueue = await this.withDeadline(
        rpcChannel.assertQueue('', { exclusive: true }),
        () => this.destroySocket(connection),
        'RabbitMQ reply queue setup timed out',
      )
      this.responseQueue = replyQueue.queue
      await this.withDeadline(
        rpcChannel.consume(this.responseQueue, message => this.handleRpcResponse(message), { noAck: true }),
        () => this.destroySocket(connection),
        'RabbitMQ reply consumer setup timed out',
      )
    } catch (error) {
      this.destroySocket(connection)
      await this.closeOwned(rpcChannel, publisherChannel, connection)
      throw error
    }

    if (this.intentionalDisconnect) {
      await this.closeOwned(rpcChannel, publisherChannel, connection)
      throw new Error('RabbitMQ connection cancelled')
    }

    this.connection = connection
    this.rpcChannel = rpcChannel
    this.publisherChannel = publisherChannel
    this.healthy = true
    this.reconnectAttempts = 0

    connection.on('error', () => this.transportFailed(connection))
    connection.on('close', () => this.transportFailed(connection))
    rpcChannel.on('error', () => this.transportFailed(connection))
    rpcChannel.on('close', () => this.transportFailed(connection))
    publisherChannel.on('error', () => this.transportFailed(connection))
    publisherChannel.on('close', () => this.transportFailed(connection))
  }

  private handleRpcResponse(message: import('amqplib').ConsumeMessage | null): void {
    if (!message) return
    try {
      const correlationId = message.properties.correlationId
      const user = JSON.parse(message.content.toString()) as UserDetails
      const entry = this.correlationMap.get(correlationId)
      if (!entry) return
      clearTimeout(entry.timer)
      this.correlationMap.delete(correlationId)
      entry.callback(user)
    } catch {
      logError('[chat-service] RabbitMQ response parse error')
    }
  }

  private transportFailed(connection: ChannelModel): void {
    if (this.connection !== connection) return
    const rpcChannel = this.rpcChannel
    const publisherChannel = this.publisherChannel
    this.connection = undefined
    this.rpcChannel = undefined
    this.publisherChannel = undefined
    this.healthy = false
    this.failPendingRequests()
    this.destroySocket(connection)
    void this.closeOwned(rpcChannel, publisherChannel, connection)
    if (!this.intentionalDisconnect) this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.intentionalDisconnect || this.reconnectTimer || this.connecting) return
    const delay = Math.min(
      MAX_RECONNECT_DELAY_MS,
      INITIAL_RECONNECT_DELAY_MS * (2 ** Math.min(this.reconnectAttempts, 5)),
    )
    this.reconnectAttempts++
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.connect().catch(() => {
        // connect() schedules the next bounded attempt.
      })
    }, delay)
    this.reconnectTimer.unref?.()
  }

  async getUserDetails(userId: string, callback: UserDetailsCallback): Promise<void> {
    const channel = this.rpcChannel
    if (!channel || !this.healthy) throw new Error('RabbitMQ is not connected')

    const correlationId = randomUUID()
    const timer = setTimeout(() => {
      const entry = this.correlationMap.get(correlationId)
      if (!entry) return
      this.correlationMap.delete(correlationId)
      try {
        entry.callback(null)
      } catch {
        logWarn('[chat-service] RabbitMQ request callback failed after timeout')
      }
    }, OPERATION_TIMEOUT_MS)
    timer.unref?.()
    this.correlationMap.set(correlationId, { callback, timer })

    try {
      channel.sendToQueue(
        this.requestQueue,
        Buffer.from(JSON.stringify({ userId })),
        { correlationId, replyTo: this.responseQueue },
      )
    } catch (error) {
      clearTimeout(timer)
      this.correlationMap.delete(correlationId)
      throw error
    }
  }

  async publishNotification(payload: NotificationPayload, eventId: string): Promise<void> {
    const channel = this.publisherChannel
    const connection = this.connection
    if (!channel || !connection || !this.healthy) throw new Error('RabbitMQ is not connected')
    const body = Buffer.from(JSON.stringify({ ...payload, eventId }))

    await new Promise<void>((resolve, reject) => {
      let confirmed = false
      let sendReturned = false
      let drained = true
      let settled = false

      const cleanup = () => {
        clearTimeout(timer)
        channel.off('drain', onDrain)
        channel.off('close', onClose)
        channel.off('error', onError)
      }
      const finish = (error?: Error) => {
        if (settled) return
        if (!error && (!sendReturned || !confirmed || !drained)) return
        settled = true
        cleanup()
        if (error) reject(error)
        else resolve()
      }
      const onDrain = () => {
        drained = true
        finish()
      }
      const onClose = () => finish(new Error('RabbitMQ publisher channel closed'))
      const onError = () => finish(new Error('RabbitMQ publisher channel failed'))
      const timer = setTimeout(() => {
        this.transportFailed(connection)
        finish(new Error('RabbitMQ publish timed out'))
      }, OPERATION_TIMEOUT_MS)
      timer.unref?.()

      channel.once('close', onClose)
      channel.once('error', onError)
      try {
        const writable = channel.sendToQueue(
          config.queue.notifications,
          body,
          { persistent: true, messageId: eventId },
          error => {
            if (error) finish(error)
            else {
              confirmed = true
              finish()
            }
          },
        )
        drained = writable
        sendReturned = true
        if (!writable) channel.once('drain', onDrain)
        finish()
      } catch (error) {
        finish(error instanceof Error ? error : new Error('RabbitMQ publish failed'))
      }
    })
  }

  async notifyReceiver(args: NotifyReceiverArgs): Promise<void> {
    const eventId = args.eventId ?? randomUUID()
    const payload: NotificationPayload = {
      type: 'MESSAGE_RECEIVED',
      eventId,
      userId: args.receiverId,
      message: args.messageContent,
      from: args.senderEmail,
      fromName: args.senderName,
      isEncrypted: Boolean(args.isEncrypted),
    }
    if (args.senderId) payload.senderId = args.senderId
    if (args.envelope) payload.envelope = args.envelope
    if (args.receiverEmail) payload.userEmail = args.receiverEmail
    if (args.receiverToken) payload.userToken = args.receiverToken
    if (args.recipientOnline !== undefined) payload.recipientOnline = args.recipientOnline

    await this.publishNotification(payload, eventId)
    logInfo('[chat-service] Notification confirmed for user:', args.receiverId)
  }

  isHealthy(): boolean {
    return this.healthy && Boolean(this.connection && this.rpcChannel && this.publisherChannel)
  }

  async disconnect(): Promise<void> {
    if (this.disconnecting) return this.disconnecting
    this.intentionalDisconnect = true
    this.healthy = false
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    this.failPendingRequests()

    const connection = this.connection
    const rpcChannel = this.rpcChannel
    const publisherChannel = this.publisherChannel
    this.connection = undefined
    this.rpcChannel = undefined
    this.publisherChannel = undefined

    const pending = (async () => {
      if (this.connecting) await this.connecting.catch(() => undefined)
      await this.closeOwned(rpcChannel, publisherChannel, connection)
      logInfo('[chat-service] RabbitMQ disconnect complete')
    })()
    this.disconnecting = pending
    try {
      await pending
    } finally {
      if (this.disconnecting === pending) this.disconnecting = undefined
    }
  }

  private failPendingRequests(): void {
    for (const { callback, timer } of this.correlationMap.values()) {
      clearTimeout(timer)
      try {
        callback(null)
      } catch {
        logWarn('[chat-service] RabbitMQ request callback failed during cleanup')
      }
    }
    this.correlationMap.clear()
  }

  private async closeOwned(
    rpcChannel?: Channel,
    publisherChannel?: ConfirmChannel,
    connection?: ChannelModel,
  ): Promise<void> {
    if (!connection && !rpcChannel && !publisherChannel) return
    let closeFailed = false
    for (const channel of [rpcChannel, publisherChannel]) {
      if (!channel) continue
      let closing: Promise<void>
      try {
        closing = channel.close()
      } catch {
        closeFailed = true
        continue
      }
      await this.withDeadline(
        closing,
        () => connection && this.destroySocket(connection),
        'RabbitMQ channel close timed out',
        CLOSE_TIMEOUT_MS,
      ).catch(() => { closeFailed = true })
    }
    let connectionResult: 'fulfilled' | 'rejected' = 'fulfilled'
    if (connection) {
      try {
        connectionResult = await this.withDeadline(
          connection.close(),
          () => this.destroySocket(connection),
          'RabbitMQ connection close timed out',
          CLOSE_TIMEOUT_MS,
        ).then(() => 'fulfilled' as const, () => 'rejected' as const)
      } catch {
        connectionResult = 'rejected'
      }
    }
    if (connection && (connectionResult === 'rejected' || closeFailed)) this.destroySocket(connection)
  }

  private destroySocket(connection: ChannelModel): void {
    try {
      ;(connection as SocketBackedConnection).connection?.stream?.destroy()
    } catch {
      // The socket is already gone.
    }
  }

  private async withDeadline<T>(
    operation: Promise<T>,
    onTimeout: () => void,
    message: string,
    timeoutMs = OPERATION_TIMEOUT_MS,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        onTimeout()
        reject(new Error(message))
      }, timeoutMs)
      timer.unref?.()
      operation.then(
        value => {
          clearTimeout(timer)
          resolve(value)
        },
        error => {
          clearTimeout(timer)
          reject(error)
        },
      )
    })
  }
}

export const rabbitMQService = new RabbitMQService()
