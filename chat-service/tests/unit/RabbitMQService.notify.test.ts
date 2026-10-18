import { EventEmitter } from 'node:events'

jest.mock('amqplib', () => ({ connect: jest.fn() }))
jest.mock('../../src/config/config', () => ({
  __esModule: true,
  default: { msgBrokerURL: 'amqps://broker.invalid', queue: { notifications: 'NOTIFICATIONS' } },
}))

import amqp from 'amqplib'
import { RabbitMQService } from '../../src/services/RabbitMQService'
import * as logger from '../../src/utils/logger'

class FakeChannel extends EventEmitter {
  assertQueue = jest.fn(async (queue: string) => ({ queue: queue || 'amq.private-chat' }))
  consume = jest.fn(async (_queue: string, _callback: (message: unknown) => void, _options?: unknown) => ({ consumerTag: 'consumer' }))
  sendToQueue = jest.fn((_queue: string, _body: Buffer, _options?: any, _callback?: (error: Error | null) => void) => true)
  close = jest.fn(async () => undefined)
}

class FakeConfirmChannel extends FakeChannel {
  sendToQueue = jest.fn((_queue: string, _body: Buffer, _options?: any, callback?: (error: Error | null) => void) => {
    callback?.(null)
    return true
  })
}

class FakeConnection extends EventEmitter {
  readonly rpc = new FakeChannel()
  readonly publisher = new FakeConfirmChannel()
  readonly destroy = jest.fn()
  createChannel = jest.fn(async () => this.rpc)
  createConfirmChannel = jest.fn(async () => this.publisher)
  close = jest.fn(async () => undefined)
  connection = { stream: { destroy: this.destroy } }
}

const payload = {
  type: 'MESSAGE_RECEIVED' as const,
  eventId: '11111111-1111-4111-8111-111111111111',
  senderId: 'sender-1',
  userId: 'receiver-1',
  message: '[Encrypted message]',
  from: 'sender@example.com',
  fromName: 'Sender',
  isEncrypted: true as const,
  envelope: '{"__encrypted":true,"body":"ciphertext"}',
}

describe('RabbitMQService confirmed publication', () => {
  beforeEach(() => jest.clearAllMocks())
  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  it('publishes the canonical event ID in the body and persistent message header after broker confirm', async () => {
    const connection = new FakeConnection()
    jest.mocked(amqp.connect).mockResolvedValue(connection as any)
    const service = new RabbitMQService('amqps://broker.invalid')
    await service.connect()

    await service.publishNotification(payload, payload.eventId)

    const [queue, body, options] = connection.publisher.sendToQueue.mock.calls[0]
    expect(queue).toBe('NOTIFICATIONS')
    expect(JSON.parse(body.toString())).toEqual(payload)
    expect(options).toEqual({ persistent: true, messageId: payload.eventId })
    expect(service.isHealthy()).toBe(true)
  })

  it('rejects synchronous send errors and broker nacks', async () => {
    const connection = new FakeConnection()
    jest.mocked(amqp.connect).mockResolvedValue(connection as any)
    const service = new RabbitMQService('amqps://broker.invalid')
    await service.connect()
    const synchronousFailure = new Error('channel closed')
    connection.publisher.sendToQueue.mockImplementationOnce(() => { throw synchronousFailure })
    await expect(service.publishNotification(payload, payload.eventId)).rejects.toBe(synchronousFailure)

    const nack = new Error('message nacked')
    connection.publisher.sendToQueue.mockImplementationOnce((_queue, _body, _options, callback) => {
      callback?.(nack)
      return true
    })
    await expect(service.publishNotification(payload, payload.eventId)).rejects.toBe(nack)
  })

  it('treats false send return as backpressure and waits for both drain and confirm', async () => {
    const connection = new FakeConnection()
    jest.mocked(amqp.connect).mockResolvedValue(connection as any)
    const service = new RabbitMQService('amqps://broker.invalid')
    await service.connect()
    let confirm!: (error: Error | null) => void
    connection.publisher.sendToQueue.mockImplementationOnce((_queue, _body, _options, callback) => {
      confirm = callback!
      return false
    })

    let settled = false
    const publishing = service.publishNotification(payload, payload.eventId).finally(() => { settled = true })
    confirm(null)
    await Promise.resolve()
    expect(settled).toBe(false)
    connection.publisher.emit('drain')
    await publishing
    expect(settled).toBe(true)
  })

  it('times out a stalled confirm, destroys the owned socket, and becomes unhealthy', async () => {
    jest.useFakeTimers()
    const connection = new FakeConnection()
    jest.mocked(amqp.connect).mockResolvedValue(connection as any)
    const service = new RabbitMQService('amqps://broker.invalid')
    await service.connect()
    connection.publisher.sendToQueue.mockImplementationOnce(() => true)

    const publishing = service.publishNotification(payload, payload.eventId)
    const rejected = expect(publishing).rejects.toThrow('RabbitMQ publish timed out')
    await jest.advanceTimersByTimeAsync(5000)
    await rejected
    expect(connection.destroy).toHaveBeenCalledTimes(1)
    expect(service.isHealthy()).toBe(false)
  })

  it('rejects a publish when the confirm channel closes', async () => {
    const connection = new FakeConnection()
    jest.mocked(amqp.connect).mockResolvedValue(connection as any)
    const service = new RabbitMQService('amqps://broker.invalid')
    await service.connect()
    connection.publisher.sendToQueue.mockImplementationOnce(() => true)

    const publishing = service.publishNotification(payload, payload.eventId)
    connection.publisher.emit('close')

    await expect(publishing).rejects.toThrow('RabbitMQ publisher channel closed')
    expect(service.isHealthy()).toBe(false)
  })

  it('keeps notifyReceiver compatible while making its publish failure observable', async () => {
    const connection = new FakeConnection()
    jest.mocked(amqp.connect).mockResolvedValue(connection as any)
    const service = new RabbitMQService('amqps://broker.invalid')
    await service.connect()
    const failure = new Error('channel closed')
    connection.publisher.sendToQueue.mockImplementationOnce(() => { throw failure })

    await expect(service.notifyReceiver({
      receiverId: 'receiver-1',
      messageContent: '[Encrypted message]',
      senderEmail: 'sender@example.com',
      senderName: 'Sender',
      isEncrypted: true,
      envelope: payload.envelope,
    })).rejects.toBe(failure)
  })
})

describe('RabbitMQService lifecycle and RPC', () => {
  beforeEach(() => jest.clearAllMocks())
  afterEach(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  it('shares concurrent initialization and configures the exclusive private RPC queue', async () => {
    const connection = new FakeConnection()
    jest.mocked(amqp.connect).mockResolvedValue(connection as any)
    const service = new RabbitMQService('amqps://broker.invalid')

    await Promise.all([service.connect(), service.connect()])

    expect(amqp.connect).toHaveBeenCalledTimes(1)
    expect(connection.rpc.assertQueue).toHaveBeenCalledWith('', { exclusive: true })
    expect(connection.publisher.assertQueue).toHaveBeenCalledWith('NOTIFICATIONS', { durable: true })
  })

  it('delivers matching RPC replies and clears the five-second callback deadline', async () => {
    jest.useFakeTimers()
    const connection = new FakeConnection()
    jest.mocked(amqp.connect).mockResolvedValue(connection as any)
    const service = new RabbitMQService('amqps://broker.invalid')
    await service.connect()
    const callback = jest.fn()
    await service.getUserDetails('user-9', callback)

    const [, , options] = connection.rpc.sendToQueue.mock.calls[0]
    const consumer = connection.rpc.consume.mock.calls[0][1] as (message: any) => void
    consumer({
      properties: { correlationId: options.correlationId },
      content: Buffer.from(JSON.stringify({ id: 'user-9', username: 'bob', email: 'bob@example.com' })),
    })

    expect(options.replyTo).toBe('amq.private-chat')
    expect(callback).toHaveBeenCalledWith({ id: 'user-9', username: 'bob', email: 'bob@example.com' })
    expect(jest.getTimerCount()).toBe(0)
  })

  it('contains a callback exception raised by the RPC deadline', async () => {
    jest.useFakeTimers()
    const warning = jest.spyOn(logger, 'logWarn').mockImplementation(() => undefined)
    const connection = new FakeConnection()
    jest.mocked(amqp.connect).mockResolvedValue(connection as any)
    const service = new RabbitMQService('amqps://broker.invalid')
    await service.connect()
    await service.getUserDetails('user-9', () => { throw new Error('callback failed') })

    expect(() => jest.advanceTimersByTime(5000)).not.toThrow()
    expect(warning).toHaveBeenCalledWith('[chat-service] RabbitMQ request callback failed after timeout')
    expect(jest.getTimerCount()).toBe(0)
  })

  it('handles channel errors during setup before a later setup operation rejects', async () => {
    jest.useFakeTimers()
    const disconnectLog = jest.spyOn(logger, 'logInfo').mockImplementation(() => undefined)
    const connection = new FakeConnection()
    let rejectSetup!: (error: Error) => void
    connection.publisher.assertQueue.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      rejectSetup = reject
    }))
    jest.mocked(amqp.connect).mockResolvedValue(connection as any)
    const service = new RabbitMQService('amqps://broker.invalid')
    const connecting = service.connect()
    const rejected = expect(connecting).rejects.toThrow('queue setup failed')

    for (let attempt = 0; attempt < 10 && !rejectSetup; attempt++) await Promise.resolve()
    expect(rejectSetup).toBeDefined()
    expect(() => connection.publisher.emit('error', new Error('setup protocol failed'))).not.toThrow()
    rejectSetup(new Error('queue setup failed'))

    await rejected
    expect(connection.destroy).toHaveBeenCalled()
    await service.disconnect()
    expect(disconnectLog).toHaveBeenCalledWith('[chat-service] RabbitMQ disconnect complete')
  })

  it('does not become healthy when setup emits an error before pending setup resolves', async () => {
    const disconnectLog = jest.spyOn(logger, 'logInfo').mockImplementation(() => undefined)
    const connection = new FakeConnection()
    let resolveSetup!: (value: { queue: string }) => void
    connection.publisher.assertQueue.mockImplementationOnce(() => new Promise(resolve => {
      resolveSetup = resolve
    }))
    jest.mocked(amqp.connect).mockResolvedValue(connection as any)
    const service = new RabbitMQService('amqps://broker.invalid')
    const connecting = service.connect()

    for (let attempt = 0; attempt < 10 && !resolveSetup; attempt++) await Promise.resolve()
    expect(resolveSetup).toBeDefined()
    expect(() => connection.publisher.emit('error', new Error('setup protocol failed'))).not.toThrow()
    resolveSetup({ queue: 'NOTIFICATIONS' })

    await expect(connecting).rejects.toThrow('setup protocol failed')
    expect(service.isHealthy()).toBe(false)
    await service.disconnect()
    expect(disconnectLog).toHaveBeenCalledWith('[chat-service] RabbitMQ disconnect complete')
  })

  it('keeps setup error listeners active while failed resources close', async () => {
    const disconnectLog = jest.spyOn(logger, 'logInfo').mockImplementation(() => undefined)
    const connection = new FakeConnection()
    let closeStarted!: () => void
    const closing = new Promise<void>(resolve => { closeStarted = resolve })
    let releaseClose!: () => void
    connection.rpc.close.mockImplementationOnce(() => new Promise<undefined>(resolve => {
      releaseClose = () => resolve(undefined)
      closeStarted()
    }))
    connection.publisher.assertQueue.mockRejectedValueOnce(new Error('queue setup failed'))
    jest.mocked(amqp.connect).mockResolvedValue(connection as any)
    const service = new RabbitMQService('amqps://broker.invalid')
    const connecting = service.connect()
    const rejected = expect(connecting).rejects.toThrow('queue setup failed')

    await closing
    expect(() => connection.rpc.emit('error', new Error('close protocol failed'))).not.toThrow()
    releaseClose()

    await rejected
    expect(() => connection.rpc.emit('error', new Error('late close protocol failed'))).not.toThrow()
    await service.disconnect()
    expect(disconnectLog).toHaveBeenCalledWith('[chat-service] RabbitMQ disconnect complete')
  })

  it('recovers after initial connection failure without a retry-count ceiling', async () => {
    jest.useFakeTimers()
    const connection = new FakeConnection()
    jest.mocked(amqp.connect)
      .mockRejectedValueOnce(new Error('broker unavailable'))
      .mockResolvedValue(connection as any)
    const service = new RabbitMQService('amqps://broker.invalid')

    await expect(service.connect()).rejects.toThrow('broker unavailable')
    await jest.advanceTimersByTimeAsync(1000)
    await Promise.resolve()

    expect(amqp.connect).toHaveBeenCalledTimes(2)
    expect(service.isHealthy()).toBe(true)
  })

  it('aborts the native connecting socket after the overall connection deadline', async () => {
    jest.useFakeTimers()
    const disconnectLog = jest.spyOn(logger, 'logInfo').mockImplementation(() => undefined)
    let signal: AbortSignal | undefined
    let rejectConnect!: (error: Error) => void
    jest.mocked(amqp.connect).mockImplementation((_url, options: any) => new Promise((_resolve, reject) => {
      signal = options.signal
      rejectConnect = reject
      signal?.addEventListener('abort', () => reject(signal?.reason))
    }))
    const service = new RabbitMQService('amqps://broker.invalid')
    const connecting = service.connect().catch(error => error)

    await jest.advanceTimersByTimeAsync(2000)
    const abortedAtDeadline = signal?.aborted ?? false
    rejectConnect(new Error('test cleanup'))
    await connecting
    await service.disconnect()

    expect(abortedAtDeadline).toBe(true)
    expect(disconnectLog).toHaveBeenCalledWith('[chat-service] RabbitMQ disconnect complete')
  })

  it('keeps reconnecting after an outage longer than the old ten-attempt ceiling', async () => {
    jest.useFakeTimers()
    const connection = new FakeConnection()
    let attempts = 0
    jest.mocked(amqp.connect).mockImplementation(async () => {
      attempts++
      if (attempts <= 11) throw new Error('broker unavailable')
      return connection as any
    })
    const service = new RabbitMQService('amqps://broker.invalid')

    await expect(service.connect()).rejects.toThrow('broker unavailable')
    for (let retry = 0; retry < 11; retry++) {
      await jest.advanceTimersToNextTimerAsync()
    }

    expect(amqp.connect).toHaveBeenCalledTimes(12)
    expect(service.isHealthy()).toBe(true)
  })

  it('ignores a late close from an old connection after reconnecting', async () => {
    jest.useFakeTimers()
    const first = new FakeConnection()
    const second = new FakeConnection()
    jest.mocked(amqp.connect).mockResolvedValueOnce(first as any).mockResolvedValueOnce(second as any)
    const service = new RabbitMQService('amqps://broker.invalid')
    await service.connect()
    first.emit('close')
    await jest.advanceTimersByTimeAsync(1000)
    await Promise.resolve()
    expect(service.isHealthy()).toBe(true)

    first.emit('close')
    expect(service.isHealthy()).toBe(true)
  })

  it('handles an idle channel error without an uncaught EventEmitter error', async () => {
    jest.useFakeTimers()
    const connection = new FakeConnection()
    jest.mocked(amqp.connect).mockResolvedValue(connection as any)
    const service = new RabbitMQService('amqps://broker.invalid')
    await service.connect()

    expect(() => connection.publisher.emit('error', new Error('protocol failed'))).not.toThrow()
    expect(service.isHealthy()).toBe(false)
  })

  it('disconnect is idempotent, cancels retries, and attempts every owned close independently', async () => {
    jest.useFakeTimers()
    const connection = new FakeConnection()
    jest.mocked(amqp.connect).mockResolvedValue(connection as any)
    const service = new RabbitMQService('amqps://broker.invalid')
    await service.connect()
    connection.rpc.close.mockImplementationOnce(() => { throw new Error('rpc close failed') })
    connection.publisher.close.mockRejectedValueOnce(new Error('publisher close failed'))
    connection.close.mockRejectedValueOnce(new Error('connection close failed'))

    await service.disconnect()
    await service.disconnect()
    await jest.runOnlyPendingTimersAsync()

    expect(connection.rpc.close).toHaveBeenCalledTimes(1)
    expect(connection.publisher.close).toHaveBeenCalledTimes(1)
    expect(connection.close).toHaveBeenCalledTimes(1)
    expect(service.isHealthy()).toBe(false)
    expect(amqp.connect).toHaveBeenCalledTimes(1)
  })

  it('waits for an active disconnect before starting another connection', async () => {
    const first = new FakeConnection()
    const second = new FakeConnection()
    let releaseClose!: () => void
    first.close.mockImplementationOnce(() => new Promise<undefined>(resolve => {
      releaseClose = () => resolve(undefined)
    }))
    jest.mocked(amqp.connect).mockResolvedValueOnce(first as any).mockResolvedValueOnce(second as any)
    const disconnectLog = jest.spyOn(logger, 'logInfo').mockImplementation(() => undefined)
    const service = new RabbitMQService('amqps://broker.invalid')
    await service.connect()

    const disconnecting = service.disconnect()
    for (let attempt = 0; attempt < 10 && !releaseClose; attempt++) await Promise.resolve()
    expect(releaseClose).toBeDefined()
    const reconnecting = service.connect()
    await Promise.resolve()

    expect(amqp.connect).toHaveBeenCalledTimes(1)
    releaseClose()
    await disconnecting
    await reconnecting

    expect(amqp.connect).toHaveBeenCalledTimes(2)
    expect(service.isHealthy()).toBe(true)
    expect(disconnectLog).toHaveBeenCalledWith('[chat-service] RabbitMQ disconnect complete')
    await service.disconnect()
  })
})
