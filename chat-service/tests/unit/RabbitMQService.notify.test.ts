// uuid ships ESM which ts-jest doesn't transform; stub it for this unit test.
jest.mock('uuid', () => ({ v4: () => 'fixed-correlation-id' }))
jest.mock('amqplib', () => ({ connect: jest.fn() }))
jest.mock('../../src/config/config', () => ({ __esModule: true, default: { msgBrokerURL: 'amqps://broker.invalid', queue: { notifications: 'NOTIFICATIONS' } } }))

import { rabbitMQService } from '../../src/services/RabbitMQService'
import amqp from 'amqplib'

describe('RabbitMQService.notifyReceiver', () => {
  afterEach(() => jest.restoreAllMocks())

  it('includes the resolved recipient email and publishes persistently', async () => {
    const channel = { sendToQueue: jest.fn() }
    ;(rabbitMQService as any).channel = channel

    await rabbitMQService.notifyReceiver({
      receiverId: 'receiver-1',
      messageContent: '[Encrypted message]',
      senderEmail: 'sender@example.com',
      senderName: 'Sender',
      isEncrypted: true,
      envelope: '{"__encrypted":true,"body":"x"}',
      receiverEmail: 'receiver@example.com',
    })

    expect(channel.sendToQueue).toHaveBeenCalledTimes(1)
    const [queue, buf, opts] = channel.sendToQueue.mock.calls[0]
    expect(queue).toBe('NOTIFICATIONS')
    const payload = JSON.parse(buf.toString())
    expect(payload.userEmail).toBe('receiver@example.com')
    expect(payload.userId).toBe('receiver-1')
    expect(payload.isEncrypted).toBe(true)
    expect(opts).toEqual({ persistent: true })
  })

  it('omits userEmail when none could be resolved (graceful degrade)', async () => {
    const channel = { sendToQueue: jest.fn() }
    ;(rabbitMQService as any).channel = channel

    await rabbitMQService.notifyReceiver({
      receiverId: 'receiver-1',
      messageContent: '[Encrypted message]',
      senderEmail: 's@x',
      senderName: 'S',
      isEncrypted: true,
    })

    const payload = JSON.parse(channel.sendToQueue.mock.calls[0][1].toString())
    expect(payload.userEmail).toBeUndefined()
  })
})

describe('RabbitMQService.getUserDetails RPC', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  it('sets a private exclusive reply queue and delivers only its matching reply', async () => {
    const channel = { assertQueue: jest.fn(async (queue: string, _options?: unknown) => ({ queue: queue || 'amq.private-chat' })), consume: jest.fn(async (_queue: string, _callback: (msg: any) => void, _options?: unknown) => ({})), sendToQueue: jest.fn() }
    jest.mocked(amqp.connect).mockResolvedValue({ createChannel: async () => channel, on: jest.fn() } as any)
    await rabbitMQService.connect()
    expect(channel.assertQueue).toHaveBeenCalledWith('', { exclusive: true })
    const callback = jest.fn()
    await rabbitMQService.getUserDetails('user-9', callback)

    const [queue, , opts] = channel.sendToQueue.mock.calls[0]
    expect(queue).toBe('USER_DETAILS_REQUEST')
    expect(opts.replyTo).toBe('amq.private-chat')
    expect(typeof opts.correlationId).toBe('string')
    expect(JSON.parse(channel.sendToQueue.mock.calls[0][1].toString())).toEqual({ userId: 'user-9' })
    const consumer = channel.consume.mock.calls[0][1]
    consumer({ properties: { correlationId: opts.correlationId }, content: Buffer.from(JSON.stringify({ id: 'user-9', username: 'bob', email: 'bob@example.com' })) })
    expect(callback).toHaveBeenCalledWith({ id: 'user-9', username: 'bob', email: 'bob@example.com' })
    expect(jest.getTimerCount()).toBe(0)
  })

  it('transport rejection clears its pending callback and timeout', async () => {
    const failure = new Error('channel closed')
    ;(rabbitMQService as any).channel = { sendToQueue: jest.fn(() => { throw failure }) }
    const callback = jest.fn()
    await expect(rabbitMQService.getUserDetails('user-9', callback)).rejects.toBe(failure)
    expect(jest.getTimerCount()).toBe(0)
    jest.advanceTimersByTime(5000)
    expect(callback).not.toHaveBeenCalled()
  })

  it('missing broker reply calls back once after the existing five-second bound', async () => {
    ;(rabbitMQService as any).channel = { sendToQueue: jest.fn() }
    const callback = jest.fn()
    await rabbitMQService.getUserDetails('user-9', callback)
    jest.advanceTimersByTime(4999)
    expect(callback).not.toHaveBeenCalled()
    jest.advanceTimersByTime(1)
    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith(null)
    expect(jest.getTimerCount()).toBe(0)
  })
})
