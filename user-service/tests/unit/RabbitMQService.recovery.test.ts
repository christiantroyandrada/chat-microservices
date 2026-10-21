import { EventEmitter } from 'node:events'
import type { ConsumeMessage } from 'amqplib'

jest.mock('../../src/config/config', () => ({ __esModule: true, default: { msgBrokerURL: 'amqp://broker' } }))
jest.mock('../../src/database', () => ({ AppDataSource: { getRepository: jest.fn() }, User: {} }))
jest.mock('amqplib', () => ({ __esModule: true, default: { connect: jest.fn() } }))

jest.mock('../../src/utils/logger', () => ({ logInfo: jest.fn(), logError: jest.fn(), logWarn: jest.fn() }))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve() }
class FakeChannel extends EventEmitter {
  callback?: (message: ConsumeMessage | null) => void
  assertQueue = jest.fn(async () => ({ queue: 'fixture', messageCount: 0, consumerCount: 0 }))
  consume = jest.fn(async (_queue: string, callback: (message: ConsumeMessage | null) => void) => {
    this.callback = callback
    return { consumerTag: 'fixture' }
  })
  sendToQueue = jest.fn(() => true)
  ack = jest.fn()
  close = jest.fn(async () => undefined)
}
class FakeConnection extends EventEmitter {
  channel = new FakeChannel()
  createChannel = jest.fn(async () => this.channel)
  close = jest.fn(async () => undefined)
  destroy = jest.fn()
  connection = { stream: { destroy: this.destroy } }
}
const message = (body: unknown): ConsumeMessage => ({
  content: Buffer.from(JSON.stringify(body)),
  fields: { deliveryTag: 1, consumerTag: 'fixture', redelivered: false, exchange: '', routingKey: 'USER_DETAILS_REQUEST' },
  properties: { replyTo: 'reply-fixture', correlationId: 'correlation-fixture' },
} as ConsumeMessage)

describe('RabbitMQ recovery contract', () => {
  let service: typeof import('../../src/services/RabbitMQService').rabbitMQService
  let connect: jest.Mock
  let repository: jest.Mock
  beforeEach(() => {
    jest.resetModules()
    jest.useFakeTimers()
    service = require('../../src/services/RabbitMQService').rabbitMQService
    connect = require('amqplib').default.connect
    repository = require('../../src/database').AppDataSource.getRepository
    repository.mockReturnValue({ findOne: jest.fn(async () => null) })
  })

  afterEach(async () => {
    await service.disconnect()
    expect(jest.getTimerCount()).toBe(0)
    jest.useRealTimers()
  })

  test('retries beyond ten failures with one timer and delays capped at thirty seconds', async () => {
    connect.mockRejectedValue(new Error('fixture unavailable'))
    await expect(service.connect()).rejects.toThrow('fixture unavailable')
    const delays = [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000, 30000, 30000]
    for (const [index, delay] of delays.entries()) {
      expect(jest.getTimerCount()).toBe(1)
      await jest.advanceTimersByTimeAsync(delay - 1)
      expect(connect).toHaveBeenCalledTimes(index + 1)
      await jest.advanceTimersByTimeAsync(1)
      expect(connect).toHaveBeenCalledTimes(index + 2)
    }
  })

  test('starts the native abort deadline before a stalled handshake', async () => {
    let signal: AbortSignal | undefined
    let rejectHandshake!: (error: Error) => void
    connect.mockImplementation((_url: string, options?: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      rejectHandshake = reject
      signal = options?.signal
      signal?.addEventListener('abort', () => reject(signal!.reason), { once: true })
    }))
    const result = service.connect().catch(error => error)
    await jest.advanceTimersByTimeAsync(10000)
    try { expect(signal?.aborted).toBe(true) } finally { rejectHandshake(new Error('fixture cleanup')) }
    expect(await result).toBeInstanceOf(Error)
  })

  test('cancels setup and joins a late channel before disconnect or a later connect completes', async () => {
    const old = new FakeConnection()
    const late = deferred<FakeChannel>()
    old.createChannel.mockReturnValue(late.promise)
    connect.mockResolvedValueOnce(old).mockResolvedValueOnce(new FakeConnection())
    const first = service.connect().catch(error => error)
    await flush()
    const stop = service.disconnect()
    const stopAgain = service.disconnect()
    const restart = service.connect()
    await flush()
    const destroyed = old.destroy.mock.calls.length
    expect(connect).toHaveBeenCalledTimes(1)
    late.resolve(old.channel)
    await Promise.all([first, stop, stopAgain, restart])
    expect(destroyed).toBe(1)
    expect(old.channel.close).toHaveBeenCalledTimes(1)
    expect(old.close).toHaveBeenCalledTimes(1)
    expect(old.channel.consume).not.toHaveBeenCalled()
    expect(connect).toHaveBeenCalledTimes(2)
    expect(service.isHealthy()).toBe(true)
  })

  test.each([
    ['connection', 'error'], ['connection', 'close'], ['channel', 'error'], ['channel', 'close']
  ])('does not promote a transport lost during setup (%s %s)', async (resource, event) => {
    const owner = new FakeConnection()
    const registration = deferred<{ consumerTag: string }>()
    owner.channel.consume.mockReturnValue(registration.promise)
    connect.mockResolvedValue(owner)
    const result = service.connect().catch(error => error)
    await flush()
    const transport = resource === 'connection' ? owner : owner.channel
    transport.emit(event, new Error('fixture failure'))
    registration.resolve({ consumerTag: 'fixture' })
    expect(await result).toBeInstanceOf(Error)
    expect(service.isHealthy()).toBe(false)
    expect(owner.close).toHaveBeenCalledTimes(1)
    expect(jest.getTimerCount()).toBe(1)
  })

  test('the overall deadline destroys setup and closes a late channel without registering a consumer', async () => {
    const owner = new FakeConnection()
    const late = deferred<FakeChannel>()
    owner.createChannel.mockReturnValue(late.promise)
    connect.mockResolvedValue(owner)
    const pending = service.connect().catch(error => error)
    await flush()
    await jest.advanceTimersByTimeAsync(10000)
    expect(owner.destroy).toHaveBeenCalledTimes(1)
    expect(service.isHealthy()).toBe(false)
    late.resolve(owner.channel)
    expect(await pending).toBeInstanceOf(Error)
    expect(owner.channel.consume).not.toHaveBeenCalled()
    expect(owner.channel.close).toHaveBeenCalledTimes(1)
    expect(owner.close).toHaveBeenCalledTimes(1)
    expect(jest.getTimerCount()).toBe(1)
    await Promise.all([service.disconnect(), service.disconnect()])
    await jest.advanceTimersByTimeAsync(30000)
    expect(connect).toHaveBeenCalledTimes(1)
  })

  test('closes the connection even when a discarded setup channel cannot close', async () => {
    const owner = new FakeConnection()
    owner.channel.assertQueue.mockRejectedValueOnce(new Error('fixture setup failure'))
    owner.channel.close.mockRejectedValueOnce(new Error('fixture close failure'))
    owner.close.mockRejectedValueOnce(new Error('fixture connection close failure'))
    connect.mockResolvedValue(owner)
    await expect(service.connect()).rejects.toThrow('fixture setup failure')
    expect(owner.channel.close).toHaveBeenCalledTimes(1)
    expect(owner.close).toHaveBeenCalledTimes(1)
    expect(owner.destroy).toHaveBeenCalled()
    expect(service.isHealthy()).toBe(false)
  })

  test('bounds both pending closes and joins disconnect without restarting recovery', async () => {
    const owner = new FakeConnection()
    const channelClose = deferred<undefined>()
    const connectionClose = deferred<undefined>()
    owner.channel.close.mockReturnValue(channelClose.promise)
    owner.close.mockReturnValue(connectionClose.promise)
    connect.mockResolvedValue(owner)
    await service.connect()
    let stopped = false
    const stop = Promise.all([service.disconnect(), service.disconnect()]).then(() => { stopped = true })
    try {
      await jest.advanceTimersByTimeAsync(999)
      expect(owner.channel.close).toHaveBeenCalledTimes(1)
      expect(owner.close).not.toHaveBeenCalled()
      expect(owner.destroy).not.toHaveBeenCalled()
      await jest.advanceTimersByTimeAsync(1)
      expect(owner.destroy).toHaveBeenCalledTimes(1)
      expect(owner.close).toHaveBeenCalledTimes(1)
      await jest.advanceTimersByTimeAsync(999)
      expect(stopped).toBe(false)
      await jest.advanceTimersByTimeAsync(1)
      expect(stopped).toBe(true)
      expect(owner.destroy).toHaveBeenCalledTimes(2)
      expect(service.isHealthy()).toBe(false)
      expect(jest.getTimerCount()).toBe(0)
      await jest.advanceTimersByTimeAsync(30000)
      expect(connect).toHaveBeenCalledTimes(1)
    } finally {
      channelClose.resolve(undefined)
      connectionClose.resolve(undefined)
      await stop
    }
  })

  test.each(['error', 'close'])('invalidates channel loss immediately and closes its owning connection (%s)', async event => {
    const owner = new FakeConnection()
    connect.mockResolvedValue(owner)
    await service.connect()
    owner.channel.close.mockRejectedValueOnce(new Error('fixture close failure'))
    owner.channel.emit(event, new Error('fixture channel failure'))
    const healthy = service.isHealthy()
    await flush()
    expect(healthy).toBe(false)
    expect(owner.channel.close).toHaveBeenCalledTimes(1)
    expect(owner.close).toHaveBeenCalledTimes(1)
  })

  test('stale events cannot invalidate replacement resources', async () => {
    const old = new FakeConnection()
    const replacement = new FakeConnection()
    connect.mockResolvedValueOnce(old).mockResolvedValueOnce(replacement)
    await service.connect()
    old.emit('close')
    await jest.advanceTimersByTimeAsync(1000)
    old.emit('error', new Error('fixture stale error'))
    old.channel.emit('close')
    expect(service.isHealthy()).toBe(true)
    expect(replacement.close).not.toHaveBeenCalled()
  })

  test('waits for consumer registration before reporting healthy', async () => {
    const owner = new FakeConnection()
    const registration = deferred<{ consumerTag: string }>()
    owner.channel.consume.mockReturnValue(registration.promise)
    connect.mockResolvedValue(owner)
    const pending = service.connect()
    const concurrent = service.connect()
    await flush()
    expect(service.isHealthy()).toBe(false)
    expect(connect).toHaveBeenCalledTimes(1)
    registration.resolve({ consumerTag: 'fixture' })
    await Promise.all([pending, concurrent])
    expect(service.isHealthy()).toBe(true)
  })

  test.each([{}, { userId: null }, { userId: 12 }, { userId: '' }])('rejects invalid RPC input without a database query (%j)', async body => {
    const owner = new FakeConnection()
    connect.mockResolvedValue(owner)
    await service.connect()
    const request = message(body)
    owner.channel.callback!(request)
    await flush()
    expect(repository).not.toHaveBeenCalled()
    expect(owner.channel.sendToQueue).toHaveBeenCalledWith('reply-fixture', Buffer.from('{"error":"Invalid message format"}'), { correlationId: 'correlation-fixture' })
    expect(owner.channel.ack).toHaveBeenCalledWith(request)
  })

  test('a request finishing after replacement sends and acknowledges only on its consumer channel', async () => {
    const old = new FakeConnection()
    const replacement = new FakeConnection()
    const query = deferred<unknown>()
    const findOne = jest.fn(() => query.promise)
    repository.mockReturnValue({ findOne })
    connect.mockResolvedValueOnce(old).mockResolvedValueOnce(replacement)
    await service.connect()
    const request = message({ userId: 'user-fixture' })
    old.channel.callback!(request)
    old.channel.emit('close')
    await jest.advanceTimersByTimeAsync(1000)
    old.channel.sendToQueue.mockImplementation(() => { throw new Error('fixture send failure') })
    old.channel.ack.mockImplementation(() => { throw new Error('fixture ack failure') })
    query.resolve({ id: 'user-fixture' })
    await flush()
    expect(findOne).toHaveBeenCalledWith({ where: { id: 'user-fixture' }, select: ['id', 'username', 'email', 'createdAt', 'updatedAt'] })
    expect(old.channel.sendToQueue).toHaveBeenCalledTimes(1)
    expect(old.channel.ack).toHaveBeenCalledTimes(1)
    expect(replacement.channel.sendToQueue).not.toHaveBeenCalled()
    expect(replacement.channel.ack).not.toHaveBeenCalled()
  })

  test('keeps notification backpressure best-effort after enqueue', async () => {
    const owner = new FakeConnection()
    connect.mockResolvedValue(owner)
    await service.connect()
    owner.channel.sendToQueue.mockReturnValue(false)
    await expect(service.publishNotification({ kind: 'fixture' })).resolves.toBe(true)
  })
})
