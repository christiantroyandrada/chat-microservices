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
    ack: jest.fn(), nack: jest.fn(), close: jest.fn(async () => undefined),
  })
  const connection = Object.assign(new EventEmitter(), { createChannel: jest.fn(async () => channel), close: jest.fn(async () => undefined) })
  return { channel, connection, deliver: (msg = message) => receive(msg) }
}

beforeEach(() => { jest.resetModules(); mockAccept.mockReset() })

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
