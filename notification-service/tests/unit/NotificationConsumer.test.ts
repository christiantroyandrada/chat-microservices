import { EventEmitter } from 'node:events'
import type { ConsumeMessage } from 'amqplib'

const mockAccept = jest.fn()
class PermanentNotificationError extends Error {}
jest.mock('../../src/services/NotificationInbox', () => ({
  notificationInbox: { accept: mockAccept }, PermanentNotificationError,
}), { virtual: true })
jest.mock('../../src/config/config', () => ({ __esModule: true, default: { msgBrokerURL: 'amqp://fixture', queue: { notifications: 'NOTIFICATIONS' } } }))
jest.mock('../../src/database', () => ({ Notification: {}, AppDataSource: {} }))
jest.mock('../../src/database/connection', () => ({ AppDataSource: {} }))
jest.mock('../../src/services/FCMService', () => ({ FCMService: { sendPushNotification: jest.fn() } }))
jest.mock('../../src/services/SecureEmailService', () => ({ SecureEmailService: jest.fn() }))
jest.mock('../../src/services/handlers/messageHandler', () => ({ handleMessageReceived: jest.fn() }))
jest.mock('../../src/services/handlers/welcomeHandler', () => ({ handleUserRegistered: jest.fn() }))
jest.mock('../../src/utils/logger', () => ({ logInfo: jest.fn(), logWarn: jest.fn(), logError: jest.fn() }))
jest.mock('amqplib', () => ({ __esModule: true, default: { connect: jest.fn() } }))

const message = { content: Buffer.from('{"type":"MESSAGE_RECEIVED"}'), properties: { messageId: 'event-fixture' } } as ConsumeMessage
async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve() }
function transport() {
  let receive!: (msg: ConsumeMessage | null) => void
  const channel = Object.assign(new EventEmitter(), {
    assertQueue: jest.fn(async () => undefined), prefetch: jest.fn(async () => undefined),
    consume: jest.fn(async (_name, callback) => { receive = callback; return { consumerTag: 'fixture' } }),
    ack: jest.fn(), nack: jest.fn(), cancel: jest.fn(async () => undefined), close: jest.fn(async () => undefined),
  })
  const destroy = jest.fn()
  const connection = Object.assign(new EventEmitter(), { createChannel: jest.fn(async () => channel), close: jest.fn(async () => undefined), connection: { stream: { destroy } } })
  return { channel, connection, destroy, deliver: (msg: ConsumeMessage | null = message) => receive(msg) }
}

beforeEach(() => { jest.resetModules(); mockAccept.mockReset() })
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks() })

test('acknowledges only after receipt commit and never constructs a provider', async () => {
  let commit!: () => void
  mockAccept.mockReturnValue(new Promise(resolve => { commit = () => resolve('inserted') }))
  const current = transport()
  require('amqplib').default.connect.mockResolvedValue(current.connection)
  const { rabbitMQService } = require('../../src/services/RabbitMQService')
  await rabbitMQService.connect()
  current.deliver()
  await flush()
  expect(mockAccept).toHaveBeenCalledWith({ type: 'MESSAGE_RECEIVED' }, 'event-fixture')
  expect(current.channel.ack).not.toHaveBeenCalled()
  commit()
  await flush()
  expect(current.channel.ack).toHaveBeenCalledWith(message)
  expect(current.channel.prefetch).toHaveBeenCalledWith(10)
  expect(require('../../src/services/SecureEmailService').SecureEmailService).not.toHaveBeenCalled()
  expect(require('../../src/services/FCMService').FCMService.sendPushNotification).not.toHaveBeenCalled()
  await rabbitMQService.disconnect()
})

test.each([false, true])('uses the original channel after replacement, failure=%s', async failure => {
  let finish!: () => void
  const pending = new Promise((resolve, reject) => { finish = () => failure ? reject(new Error('database unavailable')) : resolve('duplicate') })
  void pending.catch(() => undefined)
  mockAccept.mockReturnValue(pending)
  const old = transport()
  const replacement = transport()
  require('amqplib').default.connect.mockResolvedValueOnce(old.connection).mockResolvedValueOnce(replacement.connection)
  const { rabbitMQService } = require('../../src/services/RabbitMQService')
  await rabbitMQService.connect()
  old.deliver()
  old.connection.emit('close')
  await rabbitMQService.connect()
  finish()
  await flush()
  if (failure) expect(old.channel.nack).toHaveBeenCalledWith(message, false, true)
  else expect(old.channel.ack).toHaveBeenCalledWith(message)
  expect(replacement.channel.ack).not.toHaveBeenCalled()
  expect(replacement.channel.nack).not.toHaveBeenCalled()
  await rabbitMQService.disconnect()
})

test('discards permanent input errors but does not nack after a failed ACK', async () => {
  const current = transport()
  require('amqplib').default.connect.mockResolvedValue(current.connection)
  const { rabbitMQService } = require('../../src/services/RabbitMQService')
  await rabbitMQService.connect()
  mockAccept.mockRejectedValueOnce(new PermanentNotificationError('invalid fixture'))
  current.deliver()
  await flush()
  expect(current.channel.nack).toHaveBeenCalledWith(message, false, false)
  current.channel.nack.mockClear()
  mockAccept.mockResolvedValueOnce('duplicate')
  current.channel.ack.mockImplementationOnce(() => { throw new Error('closed channel') })
  current.deliver()
  await flush()
  expect(current.channel.ack).toHaveBeenCalledTimes(1)
  expect(current.channel.nack).not.toHaveBeenCalled()
  const invalid = { ...message, content: Buffer.from('{') }
  current.deliver(invalid)
  await flush()
  expect(current.channel.nack).toHaveBeenCalledWith(invalid, false, false)
  await rabbitMQService.disconnect()
})

test.each([['connection', 'error'], ['connection', 'close'], ['channel', 'error'], ['channel', 'close'], ['consumer', 'cancel']])('recovers %s %s, retries failed replacement, and ignores stale events', async (resource, event) => {
  jest.useFakeTimers()
  const old = transport(), replacement = transport()
  const connect = require('amqplib').default.connect
  connect.mockResolvedValueOnce(old.connection).mockRejectedValueOnce(new Error('fixture reconnect failed')).mockResolvedValueOnce(replacement.connection)
  const { rabbitMQService: service } = require('../../src/services/RabbitMQService')
  await service.connect()
  if (resource === 'consumer') old.deliver(null)
  else (resource === 'channel' ? old.channel : old.connection).emit(event, new Error('fixture transport lost'))
  expect(service.isHealthy()).toBe(false)
  await jest.advanceTimersByTimeAsync(1000)
  expect(connect).toHaveBeenCalledTimes(2)
  await jest.advanceTimersByTimeAsync(2000)
  expect(connect).toHaveBeenCalledTimes(3)
  expect(service.isHealthy()).toBe(true)
  old.connection.emit('error', new Error('fixture stale'))
  old.channel.emit('close')
  old.deliver(null)
  old.deliver()
  expect(service.isHealthy()).toBe(true)
  expect(mockAccept).not.toHaveBeenCalled()
  await service.disconnect()
  await jest.advanceTimersByTimeAsync(30000)
  expect(connect).toHaveBeenCalledTimes(3)
  expect(jest.getTimerCount()).toBe(0)
})

test('consumer cancellation during setup prevents healthy promotion', async () => {
  jest.useFakeTimers()
  const current = transport()
  current.channel.consume.mockImplementationOnce(async (_queue, callback) => { callback(null); return { consumerTag: 'fixture' } })
  require('amqplib').default.connect.mockResolvedValue(current.connection)
  const { rabbitMQService: service } = require('../../src/services/RabbitMQService')
  await expect(service.connect()).rejects.toThrow()
  expect(service.isHealthy()).toBe(false)
  expect(current.destroy).toHaveBeenCalled()
  await service.disconnect()
  expect(jest.getTimerCount()).toBe(0)
})

test('disconnect disables admission and recovery synchronously and joins admitted receipts', async () => {
  let finish!: () => void
  mockAccept.mockReturnValue(new Promise(resolve => { finish = () => resolve('inserted') }))
  const current = transport()
  require('amqplib').default.connect.mockResolvedValue(current.connection)
  const { rabbitMQService: service } = require('../../src/services/RabbitMQService')
  await service.connect()
  current.deliver()
  let joined = false
  const stopping = service.disconnect()
  expect(service.disconnect()).toBe(stopping)
  expect(service.isHealthy()).toBe(false)
  current.deliver()
  current.deliver(null)
  void stopping.then(() => { joined = true })
  await flush()
  expect(current.channel.cancel).toHaveBeenCalledWith('fixture')
  expect(mockAccept).toHaveBeenCalledTimes(1)
  expect(joined).toBe(false)
  expect(current.channel.ack).not.toHaveBeenCalled()
  finish()
  await stopping
  expect(current.channel.ack).toHaveBeenCalledWith(message)
  expect(current.channel.close).toHaveBeenCalledTimes(1)
  expect(current.connection.close).toHaveBeenCalledTimes(1)
})

test('failed consumer cancellation aborts transport and still drains the accepted receipt', async () => {
  let finish!: () => void
  mockAccept.mockReturnValue(new Promise(resolve => { finish = () => resolve('duplicate') }))
  const current = transport()
  current.channel.cancel.mockRejectedValueOnce(new Error('fixture cancel failed'))
  require('amqplib').default.connect.mockResolvedValue(current.connection)
  const { rabbitMQService: service } = require('../../src/services/RabbitMQService')
  await service.connect()
  current.deliver()
  let joined = false
  const stopping = service.disconnect().then(() => { joined = true })
  await flush()
  expect(current.destroy).toHaveBeenCalled()
  expect(joined).toBe(false)
  finish(); await stopping
  expect(current.channel.ack).toHaveBeenCalledWith(message)
  expect(current.channel.close).toHaveBeenCalledTimes(1)
  expect(current.connection.close).toHaveBeenCalledTimes(1)
})

test.each(['connection', 'channel'])('transport loss during pending registration aborts setup: %s', async resource => {
  jest.useFakeTimers()
  const current = transport()
  let registered!: (value: { consumerTag: string }) => void
  current.channel.consume.mockImplementationOnce(async () => new Promise(resolve => { registered = resolve }))
  require('amqplib').default.connect.mockResolvedValue(current.connection)
  const { rabbitMQService: service } = require('../../src/services/RabbitMQService')
  const pending = service.connect().catch((error: unknown) => error)
  await flush()
  expect(service.isHealthy()).toBe(false)
  ;(resource === 'connection' ? current.connection : current.channel).emit('error', new Error('fixture registration failed'))
  registered({ consumerTag: 'fixture' })
  expect(await pending).toBeInstanceOf(Error)
  expect(current.destroy).toHaveBeenCalled()
  expect(service.isHealthy()).toBe(false)
  await service.disconnect()
  expect(jest.getTimerCount()).toBe(0)
})

test('one setup attempt waits for registration and admits deliveries before the consume reply', async () => {
  const current = transport()
  let registered!: () => void
  current.channel.consume.mockImplementationOnce(async (_name, receive) => {
    receive(message)
    return new Promise(resolve => { registered = () => resolve({ consumerTag: 'fixture' }) })
  })
  mockAccept.mockResolvedValue('inserted')
  const connect = require('amqplib').default.connect
  connect.mockResolvedValue(current.connection)
  const { rabbitMQService: service } = require('../../src/services/RabbitMQService')
  const first = service.connect()
  expect(service.connect()).toBe(first)
  await flush()
  expect(service.isHealthy()).toBe(false)
  expect(mockAccept).toHaveBeenCalledTimes(1)
  expect(current.channel.ack).toHaveBeenCalledWith(message)
  registered(); await first
  expect(service.isHealthy()).toBe(true)
  expect(current.channel.assertQueue).toHaveBeenCalledWith('NOTIFICATIONS', { durable: true })
  expect(connect).toHaveBeenCalledTimes(1)
  await service.disconnect()
})

test('setup deadline destroys the owner and closes a channel that arrives after abort', async () => {
  jest.useFakeTimers()
  const current = transport()
  let channelReady!: (value: typeof current.channel) => void
  current.connection.createChannel.mockImplementationOnce(() => new Promise(resolve => { channelReady = resolve }))
  require('amqplib').default.connect.mockResolvedValue(current.connection)
  const { rabbitMQService: service } = require('../../src/services/RabbitMQService')
  const pending = service.connect().catch((error: unknown) => error)
  await flush()
  await jest.advanceTimersByTimeAsync(10000)
  expect(current.destroy).toHaveBeenCalledTimes(1)
  expect(service.isHealthy()).toBe(false)
  channelReady(current.channel)
  expect(await pending).toBeInstanceOf(Error)
  expect(current.channel.consume).not.toHaveBeenCalled()
  expect(current.channel.close).toHaveBeenCalledTimes(1)
  await service.disconnect()
  expect(jest.getTimerCount()).toBe(0)
})

test('disconnect during setup aborts ownership and joins a late channel without later admission', async () => {
  const current = transport()
  let channelReady!: (value: typeof current.channel) => void
  current.connection.createChannel.mockImplementationOnce(() => new Promise(resolve => { channelReady = resolve }))
  const connect = require('amqplib').default.connect
  connect.mockResolvedValue(current.connection)
  const { rabbitMQService: service } = require('../../src/services/RabbitMQService')
  const pending = service.connect().catch((error: unknown) => error)
  await flush()
  let joined = false
  const stopping = service.disconnect().then(() => { joined = true })
  expect(current.destroy).toHaveBeenCalled()
  expect(joined).toBe(false)
  channelReady(current.channel)
  expect(await pending).toBeInstanceOf(Error)
  await stopping
  expect(current.channel.consume).not.toHaveBeenCalled()
  expect(current.channel.close).toHaveBeenCalledTimes(1)
  await expect(service.connect()).rejects.toThrow('shutting down')
  expect(connect).toHaveBeenCalledTimes(1)
})

test('bounds cancellation and both close operations, aborting transport for each failure', async () => {
  jest.useFakeTimers()
  const current = transport()
  current.channel.cancel.mockImplementationOnce(() => new Promise(() => undefined))
  current.channel.close.mockImplementationOnce(() => new Promise(() => undefined))
  current.connection.close.mockImplementationOnce(() => new Promise(() => undefined))
  require('amqplib').default.connect.mockResolvedValue(current.connection)
  const { rabbitMQService: service } = require('../../src/services/RabbitMQService')
  await service.connect()
  const stopping = service.disconnect()
  await jest.advanceTimersByTimeAsync(999)
  expect(current.destroy).not.toHaveBeenCalled()
  await jest.advanceTimersByTimeAsync(1)
  expect(current.destroy).toHaveBeenCalledTimes(1)
  await jest.advanceTimersByTimeAsync(1000)
  expect(current.destroy).toHaveBeenCalledTimes(2)
  await jest.advanceTimersByTimeAsync(1000)
  await stopping
  expect(current.destroy).toHaveBeenCalledTimes(3)
  expect(jest.getTimerCount()).toBe(0)
})

test('retries indefinitely with one timer and a thirty-second maximum delay', async () => {
  jest.useFakeTimers()
  const connect = require('amqplib').default.connect
  connect.mockRejectedValue(new Error('fixture outage'))
  const { rabbitMQService: service } = require('../../src/services/RabbitMQService')
  await expect(service.connect()).rejects.toThrow('fixture outage')
  const delays = [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000, 30000, 30000]
  for (const [index, delay] of delays.entries()) {
    expect(jest.getTimerCount()).toBe(1)
    await jest.advanceTimersByTimeAsync(delay - 1)
    expect(connect).toHaveBeenCalledTimes(index + 1)
    await jest.advanceTimersByTimeAsync(1)
    expect(connect).toHaveBeenCalledTimes(index + 2)
  }
  await service.disconnect()
  expect(jest.getTimerCount()).toBe(0)
})
